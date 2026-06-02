using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Negotiate;
using Microsoft.Data.Sqlite;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAuthentication(NegotiateDefaults.AuthenticationScheme).AddNegotiate();
builder.Services.AddAuthorization();
var app = builder.Build();

var dbPath = Path.Combine(app.Environment.ContentRootPath, "training.db");
var sessions = new ConcurrentDictionary<string, AdminSession>();
var userSessions = new ConcurrentDictionary<string, UserSession>();
const int sessionTtlSeconds = 6 * 60 * 60;
const int userSessionTtlSeconds = 14 * 24 * 60 * 60;

InitDb();

app.UseDefaultFiles();
app.UseStaticFiles();
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/api/app-data", (HttpRequest request) =>
{
    var userEmail = UserEmail(request);
    using var conn = OpenDb();

    var courses = ActiveRows(Rows(conn, "SELECT * FROM courses")).OrderBy(OrderValue).ToList();
    var modules = ActiveRows(Rows(conn, "SELECT * FROM modules")).OrderBy(OrderValue).ToList();
    var activities = ActiveRows(Rows(conn, "SELECT * FROM activities")).OrderBy(OrderValue).ToList();
    var sqlSchemas = ActiveRows(Rows(conn, "SELECT * FROM sqlSchemas")).ToList();

    FinalizeExpiredSessions(conn, userEmail, modules, activities);

    var attempts = Rows(conn, "SELECT * FROM assessmentAttempts WHERE userEmail=$userEmail ORDER BY submittedAt",
        new() { ["$userEmail"] = userEmail });
    var overrides = ActiveRows(Rows(conn, "SELECT * FROM assessmentAttemptOverrides WHERE userEmail=$userEmail",
        new() { ["$userEmail"] = userEmail })).ToList();
    var attemptSessions = Rows(conn, "SELECT * FROM assessmentAttemptSessions WHERE userEmail=$userEmail",
        new() { ["$userEmail"] = userEmail });
    var drafts = Rows(conn, "SELECT moduleId,activityId,answerJson,updatedAt FROM answerDrafts WHERE userEmail=$userEmail",
        new() { ["$userEmail"] = userEmail }).Select(d => new Dictionary<string, object?>
        {
            ["moduleId"] = ObjString(d, "moduleId"),
            ["activityId"] = ObjString(d, "activityId"),
            ["answer"] = ParseJsonObject(ObjString(d, "answerJson", "{}")),
            ["updatedAt"] = ObjString(d, "updatedAt")
        }).ToList();

    return Results.Json(new Dictionary<string, object?>
    {
        ["version"] = "migrated-dotnet-v1",
        ["userEmail"] = userEmail,
        ["authUser"] = CurrentAuthUser(request),
        ["courses"] = courses,
        ["modules"] = modules,
        ["activities"] = activities,
        ["sqlSchemas"] = sqlSchemas,
        ["assessmentProgress"] = BuildAssessmentProgress(modules, attempts, overrides, attemptSessions),
        ["drafts"] = drafts
    });
});

app.MapGet("/api/auth/windows", async (HttpContext context) =>
{
    var auth = await context.AuthenticateAsync(NegotiateDefaults.AuthenticationScheme);
    if (!auth.Succeeded || auth.Principal?.Identity?.IsAuthenticated != true)
    {
        await context.ChallengeAsync(NegotiateDefaults.AuthenticationScheme);
        return;
    }

    var windowsName = auth.Principal.Identity?.Name ?? "";
    var email = WindowsEmail(windowsName);
    using var conn = OpenDb();
    EnsureUser(conn, email, windowsName, "windows");
    var token = CreateUserSession(email, windowsName, "windows");
    await Results.Json(new { token, email, displayName = windowsName, authType = "windows" }).ExecuteAsync(context);
});

app.MapPost("/api/{**rest}", async (string rest, HttpRequest request) =>
{
    JsonObject payload;
    try
    {
        payload = await JsonNode.ParseAsync(request.Body) as JsonObject ?? new JsonObject();
    }
    catch
    {
        return Results.Json(new { error = "Invalid JSON" }, statusCode: 400);
    }

    using var conn = OpenDb();
    try
    {
        var path = "/api/" + rest;

        if (path == "/api/auth/register")
        {
            var email = NormalizeEmail(Required(payload, "email", "Email"));
            var displayName = S(payload, "displayName", email).Trim();
            var password = Required(payload, "password", "Password");
            if (password.Length < 6) throw new AppError("Password must contain at least 6 characters.");
            if (Rows(conn, "SELECT 1 FROM appUsers WHERE email=$email", new() { ["$email"] = email }).Any())
                throw new AppError("User already exists.");
            Exec(conn,
                "INSERT INTO appUsers(email,displayName,passwordHash,authType,role,status,createdAt,lastLoginAt) VALUES($email,$displayName,$passwordHash,'password','student','active',$createdAt,'')",
                new() { ["$email"] = email, ["$displayName"] = displayName, ["$passwordHash"] = HashPassword(password), ["$createdAt"] = NowIso() });
            var token = CreateUserSession(email, displayName, "password", "student");
            return Results.Json(new { token, email, displayName, authType = "password", role = "student", adminToken = "" });
        }

        if (path == "/api/auth/login")
        {
            var email = ResolveLoginId(Required(payload, "email", "Email or username"));
            var password = Required(payload, "password", "Password");
            var user = Rows(conn, "SELECT * FROM appUsers WHERE email=$email AND status='active'", new() { ["$email"] = email }).FirstOrDefault();
            if (user is null || !VerifyPassword(password, ObjString(user, "passwordHash")))
                throw new AppError("Invalid email or password.");
            Exec(conn, "UPDATE appUsers SET lastLoginAt=$lastLoginAt WHERE email=$email", new() { ["$lastLoginAt"] = NowIso(), ["$email"] = email });
            var role = ObjString(user, "role", "student");
            var token = CreateUserSession(email, ObjString(user, "displayName", email), ObjString(user, "authType", "password"), role);
            var adminToken = "";
            if (role == "admin")
            {
                adminToken = Token();
                sessions[adminToken] = new AdminSession(ObjString(user, "displayName", email), DateTimeOffset.UtcNow.AddSeconds(sessionTtlSeconds));
            }
            return Results.Json(new { token, email, displayName = ObjString(user, "displayName", email), authType = ObjString(user, "authType", "password"), role, adminToken });
        }

        if (path == "/api/auth/logout")
        {
            var token = BearerToken(request);
            if (token.Length > 0) userSessions.TryRemove(token, out _);
            return Results.Json(new { status = "ok" });
        }

        if (path == "/api/draft/save")
        {
            var userEmail = UserEmail(request);
            if (CurrentUserSession(request) is null) throw new AppError("Sign in to save drafts.");
            var moduleId = Required(payload, "moduleId", "Module ID");
            var activityId = Required(payload, "activityId", "Activity ID");
            var answerJson = (payload["answer"] ?? new JsonObject()).ToJsonString();
            Exec(conn,
                """
                INSERT INTO answerDrafts(userEmail,moduleId,activityId,answerJson,updatedAt)
                VALUES($userEmail,$moduleId,$activityId,$answerJson,$updatedAt)
                ON CONFLICT(userEmail,moduleId,activityId) DO UPDATE SET answerJson=$answerJson, updatedAt=$updatedAt
                """,
                new() { ["$userEmail"] = userEmail, ["$moduleId"] = moduleId, ["$activityId"] = activityId, ["$answerJson"] = answerJson, ["$updatedAt"] = NowIso() });
            return Results.Json(new { status = "ok" });
        }

        if (path == "/api/draft/clear-module")
        {
            var userEmail = UserEmail(request);
            var moduleId = Required(payload, "moduleId", "Module ID");
            Exec(conn, "DELETE FROM answerDrafts WHERE userEmail=$userEmail AND moduleId=$moduleId", new() { ["$userEmail"] = userEmail, ["$moduleId"] = moduleId });
            return Results.Json(new { status = "ok" });
        }

        if (path == "/api/admin/login")
        {
            var username = S(payload, "username").Trim();
            var password = S(payload, "password");
            var user = Rows(conn,
                "SELECT * FROM adminUsers WHERE username=$username AND password=$password AND role='admin' AND status='active'",
                new() { ["$username"] = username, ["$password"] = password }).FirstOrDefault();
            if (user is null) throw new AppError("Invalid admin login or password.");

            var token = Token();
            sessions[token] = new AdminSession(username, DateTimeOffset.UtcNow.AddSeconds(sessionTtlSeconds));
            return Results.Json(new { token, username });
        }

        if (path == "/api/course/create")
        {
            RequireAdmin(payload);
            var courseId = SafeId(S(payload, "courseId", S(payload, "title")), "course");
            if (Rows(conn, "SELECT 1 FROM courses WHERE courseId=$courseId", new() { ["$courseId"] = courseId }).Any())
                throw new AppError($"Course ID already exists: {courseId}");

            Exec(conn,
                "INSERT INTO courses(courseId,title,description,category,level,displayOrder,passingScore,status) VALUES($courseId,$title,$description,$category,$level,$displayOrder,$passingScore,$status)",
                new()
                {
                    ["$courseId"] = courseId,
                    ["$title"] = Required(payload, "title", "Course title"),
                    ["$description"] = S(payload, "description"),
                    ["$category"] = S(payload, "category"),
                    ["$level"] = S(payload, "level", "Beginner"),
                    ["$displayOrder"] = I(payload, "displayOrder", NextOrder(conn, "courses")),
                    ["$passingScore"] = I(payload, "passingScore"),
                    ["$status"] = S(payload, "status", "active")
                });
            return Results.Json(new { status = "ok", courseId });
        }

        if (path == "/api/course/update")
        {
            RequireAdmin(payload);
            var courseId = Required(payload, "courseId", "Course ID");
            var current = Rows(conn, "SELECT * FROM courses WHERE courseId=$courseId", new() { ["$courseId"] = courseId }).FirstOrDefault();
            if (current is null) throw new AppError($"Course not found: {courseId}");

            Exec(conn,
                "UPDATE courses SET title=$title,description=$description,category=$category,level=$level,displayOrder=$displayOrder,passingScore=$passingScore,status=$status WHERE courseId=$courseId",
                new()
                {
                    ["$title"] = Required(payload, "title", "Course title"),
                    ["$description"] = S(payload, "description"),
                    ["$category"] = S(payload, "category"),
                    ["$level"] = S(payload, "level", "Beginner"),
                    ["$displayOrder"] = I(payload, "displayOrder", ObjInt(current, "displayOrder", 1)),
                    ["$passingScore"] = I(payload, "passingScore"),
                    ["$status"] = S(payload, "status", "active"),
                    ["$courseId"] = courseId
                });
            return Results.Json(new { status = "ok" });
        }

        if (path == "/api/course/delete")
        {
            RequireAdmin(payload);
            var courseId = Required(payload, "courseId", "Course ID");
            if (!Rows(conn, "SELECT 1 FROM courses WHERE courseId=$courseId", new() { ["$courseId"] = courseId }).Any())
                throw new AppError($"Course not found: {courseId}");
            Exec(conn, "UPDATE courses SET status='inactive' WHERE courseId=$courseId", new() { ["$courseId"] = courseId });
            Exec(conn, "UPDATE modules SET status='inactive' WHERE courseId=$courseId", new() { ["$courseId"] = courseId });
            Exec(conn, "UPDATE activities SET status='inactive' WHERE courseId=$courseId", new() { ["$courseId"] = courseId });
            return Results.Json(new { status = "ok" });
        }

        if (path == "/api/course/reorder")
        {
            RequireAdmin(payload);
            var ordered = StringArray(payload, "orderedIds");
            var active = Rows(conn, "SELECT courseId FROM courses WHERE status='active'").Select(x => ObjString(x, "courseId")).ToHashSet();
            if (!ordered.ToHashSet().SetEquals(active)) throw new AppError("Course order does not match active courses.");
            UpdateOrder(conn, "courses", "courseId", ordered);
            return Results.Json(new { status = "ok" });
        }

        if (path == "/api/module/create")
        {
            RequireAdmin(payload);
            var moduleId = SafeId(S(payload, "moduleId", S(payload, "title")), "mod");
            var values = ModulePayload(payload, NextOrder(conn, "modules", "courseId=$courseId", new() { ["$courseId"] = S(payload, "courseId") }));
            Exec(conn,
                "INSERT INTO modules(moduleId,courseId,title,description,displayOrder,status,moduleType,maxAttempts,passingScore,reviewMode,lockAfterSubmit,isTimed,timeLimitMinutes) VALUES($moduleId,$courseId,$title,$description,$displayOrder,$status,$moduleType,$maxAttempts,$passingScore,$reviewMode,$lockAfterSubmit,$isTimed,$timeLimitMinutes)",
                values.With("$moduleId", moduleId));
            return Results.Json(new { status = "ok", moduleId });
        }

        if (path == "/api/module/update")
        {
            RequireAdmin(payload);
            var moduleId = Required(payload, "moduleId", "Module ID");
            var current = Rows(conn, "SELECT * FROM modules WHERE moduleId=$moduleId", new() { ["$moduleId"] = moduleId }).FirstOrDefault();
            if (current is null) throw new AppError($"Module not found: {moduleId}");
            var values = ModulePayload(payload, ObjInt(current, "displayOrder", 1));
            Exec(conn,
                "UPDATE modules SET courseId=$courseId,title=$title,description=$description,displayOrder=$displayOrder,status=$status,moduleType=$moduleType,maxAttempts=$maxAttempts,passingScore=$passingScore,reviewMode=$reviewMode,lockAfterSubmit=$lockAfterSubmit,isTimed=$isTimed,timeLimitMinutes=$timeLimitMinutes WHERE moduleId=$moduleId",
                values.With("$moduleId", moduleId));
            Exec(conn, "UPDATE activities SET courseId=$courseId WHERE moduleId=$moduleId",
                new() { ["$courseId"] = values["$courseId"], ["$moduleId"] = moduleId });
            return Results.Json(new { status = "ok" });
        }

        if (path == "/api/module/delete")
        {
            RequireAdmin(payload);
            var moduleId = Required(payload, "moduleId", "Module ID");
            if (!Rows(conn, "SELECT 1 FROM modules WHERE moduleId=$moduleId", new() { ["$moduleId"] = moduleId }).Any())
                throw new AppError($"Module not found: {moduleId}");
            Exec(conn, "UPDATE modules SET status='inactive' WHERE moduleId=$moduleId", new() { ["$moduleId"] = moduleId });
            Exec(conn, "UPDATE activities SET status='inactive' WHERE moduleId=$moduleId", new() { ["$moduleId"] = moduleId });
            return Results.Json(new { status = "ok" });
        }

        if (path == "/api/module/reorder")
        {
            RequireAdmin(payload);
            var courseId = Required(payload, "courseId", "Course ID");
            var ordered = StringArray(payload, "orderedIds");
            var active = Rows(conn, "SELECT moduleId FROM modules WHERE courseId=$courseId AND status='active'",
                new() { ["$courseId"] = courseId }).Select(x => ObjString(x, "moduleId")).ToHashSet();
            if (!ordered.ToHashSet().SetEquals(active)) throw new AppError("Module order does not match active modules in the selected course.");
            UpdateOrder(conn, "modules", "moduleId", ordered);
            return Results.Json(new { status = "ok" });
        }

        if (path == "/api/activity/create")
        {
            RequireAdmin(payload);
            var module = Rows(conn, "SELECT * FROM modules WHERE moduleId=$moduleId", new() { ["$moduleId"] = S(payload, "moduleId") }).FirstOrDefault()
                ?? throw new AppError("Module not found.");
            var activityId = SafeId(S(payload, "activityId", S(payload, "title", S(payload, "activityType"))), "act");
            var insertOrder = ActivityInsertOrder(conn, ObjString(module, "moduleId"), payload);
            var values = ActivityPayload(payload, module, insertOrder);
            Exec(conn,
                "INSERT INTO activities(activityId,courseId,moduleId,activityType,title,content,configJson,displayOrder,status,validationJson,points,manualReviewRequired) VALUES($activityId,$courseId,$moduleId,$activityType,$title,$content,$configJson,$displayOrder,$status,$validationJson,$points,$manualReviewRequired)",
                values.With("$activityId", activityId));
            return Results.Json(new { status = "ok", activityId });
        }

        if (path == "/api/activity/update")
        {
            RequireAdmin(payload);
            var activityId = Required(payload, "activityId", "Activity ID");
            var current = Rows(conn, "SELECT * FROM activities WHERE activityId=$activityId", new() { ["$activityId"] = activityId }).FirstOrDefault();
            if (current is null) throw new AppError($"Activity not found: {activityId}");
            var module = Rows(conn, "SELECT * FROM modules WHERE moduleId=$moduleId", new() { ["$moduleId"] = S(payload, "moduleId") }).FirstOrDefault()
                ?? throw new AppError("Module not found.");
            var values = ActivityPayload(payload, module, ObjInt(current, "displayOrder", 1));
            Exec(conn,
                "UPDATE activities SET courseId=$courseId,moduleId=$moduleId,activityType=$activityType,title=$title,content=$content,configJson=$configJson,displayOrder=$displayOrder,status=$status,validationJson=$validationJson,points=$points,manualReviewRequired=$manualReviewRequired WHERE activityId=$activityId",
                values.With("$activityId", activityId));
            NormalizeActivityOrders(conn, ObjString(module, "moduleId"));
            return Results.Json(new { status = "ok" });
        }

        if (path == "/api/activity/delete")
        {
            RequireAdmin(payload);
            var activityId = Required(payload, "activityId", "Activity ID");
            var current = Rows(conn, "SELECT * FROM activities WHERE activityId=$activityId", new() { ["$activityId"] = activityId }).FirstOrDefault();
            if (current is null) throw new AppError($"Activity not found: {activityId}");
            Exec(conn, "UPDATE activities SET status='inactive' WHERE activityId=$activityId", new() { ["$activityId"] = activityId });
            NormalizeActivityOrders(conn, ObjString(current, "moduleId"));
            return Results.Json(new { status = "ok" });
        }

        if (path == "/api/activity/reorder")
        {
            RequireAdmin(payload);
            var moduleId = Required(payload, "moduleId", "Module ID");
            var ordered = StringArray(payload, "orderedIds");
            var active = Rows(conn, "SELECT activityId FROM activities WHERE moduleId=$moduleId AND status='active'",
                new() { ["$moduleId"] = moduleId }).Select(x => ObjString(x, "activityId")).ToHashSet();
            if (!ordered.ToHashSet().SetEquals(active)) throw new AppError("Activity order does not match active activities in the selected module.");
            UpdateOrder(conn, "activities", "activityId", ordered);
            return Results.Json(new { status = "ok" });
        }

        if (path == "/api/assessment/start-attempt")
        {
            var userEmail = UserEmail(request);
            var module = Rows(conn, "SELECT * FROM modules WHERE moduleId=$moduleId AND moduleType='assessment' AND status='active'",
                new() { ["$moduleId"] = S(payload, "moduleId") }).FirstOrDefault() ?? throw new AppError("Assessment module not found.");
            if (!Truthy(ObjString(module, "isTimed"))) return Results.Json(new { status = "not_required" });

            var attempts = Rows(conn, "SELECT * FROM assessmentAttempts WHERE userEmail=$userEmail AND assessmentBlockId=$moduleId",
                new() { ["$userEmail"] = userEmail, ["$moduleId"] = ObjString(module, "moduleId") });
            var overrides = ActiveRows(Rows(conn, "SELECT * FROM assessmentAttemptOverrides WHERE userEmail=$userEmail AND assessmentBlockId=$moduleId",
                new() { ["$userEmail"] = userEmail, ["$moduleId"] = ObjString(module, "moduleId") })).ToList();
            var maxAttempts = EffectiveMaxAttempts(module, overrides);
            if (attempts.Count >= maxAttempts) throw new AppError("No attempts left for this assessment module.");

            var existing = Rows(conn, "SELECT * FROM assessmentAttemptSessions WHERE userEmail=$userEmail AND moduleId=$moduleId AND status='active'",
                new() { ["$userEmail"] = userEmail, ["$moduleId"] = ObjString(module, "moduleId") }).FirstOrDefault();
            if (existing is not null) return Results.Json(SessionResponse(existing));

            var now = DateTimeOffset.UtcNow;
            var session = new Dictionary<string, object?>
            {
                ["sessionId"] = "sess_" + Guid.NewGuid().ToString("N"),
                ["userEmail"] = userEmail,
                ["courseId"] = ObjString(module, "courseId"),
                ["moduleId"] = ObjString(module, "moduleId"),
                ["attemptNo"] = attempts.Count + 1,
                ["startedAt"] = now.ToString("O"),
                ["expiresAt"] = now.AddMinutes(Math.Max(1, ObjInt(module, "timeLimitMinutes", 1))).ToString("O"),
                ["status"] = "active",
                ["submittedAt"] = "",
                ["submissionReason"] = ""
            };
            Exec(conn,
                "INSERT INTO assessmentAttemptSessions(sessionId,userEmail,courseId,moduleId,attemptNo,startedAt,expiresAt,status,submittedAt,submissionReason) VALUES($sessionId,$userEmail,$courseId,$moduleId,$attemptNo,$startedAt,$expiresAt,$status,$submittedAt,$submissionReason)",
                ParamDict(session));
            return Results.Json(SessionResponse(session));
        }

        if (path == "/api/assessment/submit-module")
        {
            var userEmail = UserEmail(request);
            var module = Rows(conn, "SELECT * FROM modules WHERE moduleId=$moduleId AND moduleType='assessment' AND status='active'",
                new() { ["$moduleId"] = S(payload, "moduleId") }).FirstOrDefault() ?? throw new AppError("Assessment module not found.");
            var tasks = ActiveRows(Rows(conn, "SELECT * FROM activities WHERE moduleId=$moduleId ORDER BY displayOrder",
                new() { ["$moduleId"] = ObjString(module, "moduleId") })).ToList();
            var attempts = Rows(conn, "SELECT * FROM assessmentAttempts WHERE userEmail=$userEmail AND assessmentBlockId=$moduleId",
                new() { ["$userEmail"] = userEmail, ["$moduleId"] = ObjString(module, "moduleId") });
            var overrides = ActiveRows(Rows(conn, "SELECT * FROM assessmentAttemptOverrides WHERE userEmail=$userEmail AND assessmentBlockId=$moduleId",
                new() { ["$userEmail"] = userEmail, ["$moduleId"] = ObjString(module, "moduleId") })).ToList();
            var maxAttempts = EffectiveMaxAttempts(module, overrides);
            if (attempts.Count >= maxAttempts) throw new AppError("No attempts left for this assessment module.");

            Dictionary<string, object?>? session = null;
            if (Truthy(ObjString(module, "isTimed")))
            {
                session = Rows(conn, "SELECT * FROM assessmentAttemptSessions WHERE userEmail=$userEmail AND moduleId=$moduleId AND status='active'",
                    new() { ["$userEmail"] = userEmail, ["$moduleId"] = ObjString(module, "moduleId") }).FirstOrDefault();
                if (session is null) throw new AppError("Start attempt before submitting this timed assessment.");
            }

            var expired = session is not null && DateTimeOffset.Parse(ObjString(session, "expiresAt")) <= DateTimeOffset.UtcNow;
            var reason = expired ? "time_expired" : S(payload, "submissionReason", "manual");
            var taskResults = expired && S(payload, "submissionReason") != "time_expired"
                ? new JsonArray()
                : payload["taskResults"] as JsonArray ?? new JsonArray();
                var result = CompleteAssessmentAttempt(conn, module, tasks, userEmail, attempts.Count + 1, taskResults, reason, session, maxAttempts);
                Exec(conn, "DELETE FROM answerDrafts WHERE userEmail=$userEmail AND moduleId=$moduleId",
                    new() { ["$userEmail"] = userEmail, ["$moduleId"] = ObjString(module, "moduleId") });
                return Results.Json(result);
        }

        if (path == "/api/learning-event")
        {
            var userEmail = UserEmail(request);
            Exec(conn,
                "INSERT INTO learningEvents(eventId,userEmail,courseId,activityId,activityType,eventType,answerJson,isCorrect,feedback,createdAt) VALUES($eventId,$userEmail,$courseId,$activityId,$activityType,$eventType,$answerJson,$isCorrect,$feedback,$createdAt)",
                new()
                {
                    ["$eventId"] = "le_" + Guid.NewGuid().ToString("N"),
                    ["$userEmail"] = userEmail,
                    ["$courseId"] = S(payload, "courseId"),
                    ["$activityId"] = S(payload, "activityId"),
                    ["$activityType"] = S(payload, "activityType"),
                    ["$eventType"] = S(payload, "eventType", "check_answer"),
                    ["$answerJson"] = (payload["answer"] ?? new JsonObject()).ToJsonString(),
                    ["$isCorrect"] = Truthy(payload["isCorrect"]).ToString(),
                    ["$feedback"] = S(payload, "feedback"),
                    ["$createdAt"] = NowIso()
                });
            return Results.Json(new { status = "ok" });
        }

        return Results.Json(new { error = "Unknown endpoint" }, statusCode: 404);
    }
    catch (AppError ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: 400);
    }
    catch (Exception ex)
    {
        return Results.Json(new { error = $"Server error: {ex.Message}" }, statusCode: 500);
    }
});

app.MapFallbackToFile("index.html");

var port = Environment.GetEnvironmentVariable("PORT") ?? "8000";
app.Run($"http://127.0.0.1:{port}");

SqliteConnection OpenDb()
{
    var conn = new SqliteConnection($"Data Source={dbPath}");
    conn.Open();
    return conn;
}

void InitDb()
{
    using var conn = OpenDb();
    Exec(conn, """
CREATE TABLE IF NOT EXISTS courses (
  courseId TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  category TEXT DEFAULT '',
  level TEXT DEFAULT 'Beginner',
  displayOrder INTEGER DEFAULT 1,
  passingScore INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS modules (
  moduleId TEXT PRIMARY KEY,
  courseId TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  displayOrder INTEGER DEFAULT 1,
  status TEXT DEFAULT 'active',
  moduleType TEXT DEFAULT 'learning',
  maxAttempts INTEGER,
  passingScore INTEGER,
  reviewMode TEXT,
  lockAfterSubmit TEXT,
  isTimed TEXT,
  timeLimitMinutes INTEGER
);
CREATE TABLE IF NOT EXISTS activities (
  activityId TEXT PRIMARY KEY,
  courseId TEXT NOT NULL,
  moduleId TEXT NOT NULL,
  activityType TEXT NOT NULL,
  title TEXT DEFAULT '',
  content TEXT DEFAULT '',
  configJson TEXT DEFAULT '{}',
  displayOrder INTEGER DEFAULT 1,
  status TEXT DEFAULT 'active',
  validationJson TEXT DEFAULT '{}',
  points INTEGER,
  manualReviewRequired TEXT
);
CREATE TABLE IF NOT EXISTS sqlSchemas (
  schemaId TEXT PRIMARY KEY,
  title TEXT,
  description TEXT,
  initSql TEXT,
  status TEXT DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS learningEvents (
  eventId TEXT PRIMARY KEY,
  userEmail TEXT,
  courseId TEXT,
  activityId TEXT,
  activityType TEXT,
  eventType TEXT,
  answerJson TEXT,
  isCorrect TEXT,
  feedback TEXT,
  createdAt TEXT
);
CREATE TABLE IF NOT EXISTS assessmentAttempts (
  attemptId TEXT PRIMARY KEY,
  userEmail TEXT,
  courseId TEXT,
  assessmentBlockId TEXT,
  attemptNo INTEGER,
  totalScore INTEGER,
  maxScore INTEGER,
  scorePercent INTEGER,
  resultStatus TEXT,
  submittedAt TEXT,
  lockedAfterSubmit TEXT,
  submissionReason TEXT,
  sessionId TEXT
);
CREATE TABLE IF NOT EXISTS assessmentTaskAttempts (
  taskAttemptId TEXT PRIMARY KEY,
  attemptId TEXT,
  userEmail TEXT,
  assessmentBlockId TEXT,
  assessmentTaskId TEXT,
  taskType TEXT,
  answerJson TEXT,
  interpreterStatus TEXT,
  interpreterOutput TEXT,
  validationStatus TEXT,
  validationOutput TEXT,
  score INTEGER,
  manualReviewRequired TEXT
);
CREATE TABLE IF NOT EXISTS assessmentAttemptOverrides (
  overrideId TEXT PRIMARY KEY,
  userEmail TEXT,
  courseId TEXT,
  assessmentBlockId TEXT,
  maxAttemptsOverride INTEGER,
  reason TEXT,
  createdBy TEXT,
  createdAt TEXT,
  status TEXT DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS assessmentAttemptSessions (
  sessionId TEXT PRIMARY KEY,
  userEmail TEXT,
  courseId TEXT,
  moduleId TEXT,
  attemptNo INTEGER,
  startedAt TEXT,
  expiresAt TEXT,
  status TEXT,
  submittedAt TEXT,
  submissionReason TEXT
);
CREATE TABLE IF NOT EXISTS adminUsers (
  username TEXT PRIMARY KEY,
  password TEXT,
  role TEXT,
  status TEXT,
  createdAt TEXT
);
CREATE TABLE IF NOT EXISTS appUsers (
  email TEXT PRIMARY KEY,
  displayName TEXT,
  passwordHash TEXT,
  authType TEXT,
  role TEXT DEFAULT 'student',
  status TEXT,
  createdAt TEXT,
  lastLoginAt TEXT
);
CREATE TABLE IF NOT EXISTS answerDrafts (
  userEmail TEXT,
  moduleId TEXT,
  activityId TEXT,
  answerJson TEXT,
  updatedAt TEXT,
  PRIMARY KEY(userEmail,moduleId,activityId)
);
""");
    if (!Rows(conn, "SELECT username FROM adminUsers WHERE username='admin'").Any())
    {
        Exec(conn, "INSERT INTO adminUsers(username,password,role,status,createdAt) VALUES('admin','admin','admin','active',$createdAt)",
            new() { ["$createdAt"] = NowIso() });
    }
    AddColumnIfMissing(conn, "appUsers", "role", "TEXT DEFAULT 'student'");
    if (!Rows(conn, "SELECT 1 FROM appUsers WHERE email='admin@example.local'").Any())
    {
        Exec(conn,
            "INSERT INTO appUsers(email,displayName,passwordHash,authType,role,status,createdAt,lastLoginAt) VALUES('admin@example.local','Admin',$passwordHash,'password','admin','active',$createdAt,'')",
            new() { ["$passwordHash"] = HashPassword("admin"), ["$createdAt"] = NowIso() });
    }
    else
    {
        Exec(conn, "UPDATE appUsers SET role='admin', status='active' WHERE email='admin@example.local'");
    }
}

List<Dictionary<string, object?>> Rows(SqliteConnection conn, string sql, Dictionary<string, object?>? parameters = null)
{
    using var cmd = conn.CreateCommand();
    cmd.CommandText = sql;
    AddParams(cmd, parameters);
    using var reader = cmd.ExecuteReader();
    var result = new List<Dictionary<string, object?>>();
    while (reader.Read())
    {
        var row = new Dictionary<string, object?>();
        for (var i = 0; i < reader.FieldCount; i++)
        {
            row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
        }
        result.Add(row);
    }
    return result;
}

void Exec(SqliteConnection conn, string sql, Dictionary<string, object?>? parameters = null)
{
    using var cmd = conn.CreateCommand();
    cmd.CommandText = sql;
    AddParams(cmd, parameters);
    cmd.ExecuteNonQuery();
}

void AddColumnIfMissing(SqliteConnection conn, string table, string column, string definition)
{
    var existing = Rows(conn, $"PRAGMA table_info({table})").Any(r => ObjString(r, "name").Equals(column, StringComparison.OrdinalIgnoreCase));
    if (!existing) Exec(conn, $"ALTER TABLE {table} ADD COLUMN {column} {definition}");
}

void AddParams(SqliteCommand cmd, Dictionary<string, object?>? parameters)
{
    if (parameters is null) return;
    foreach (var (key, value) in parameters)
    {
        cmd.Parameters.AddWithValue(key, value ?? DBNull.Value);
    }
}

IEnumerable<Dictionary<string, object?>> ActiveRows(IEnumerable<Dictionary<string, object?>> items) =>
    items.Where(x => ObjString(x, "status").Equals("active", StringComparison.OrdinalIgnoreCase));

int OrderValue(Dictionary<string, object?> row) => ObjInt(row, "displayOrder");

string NowIso() => DateTimeOffset.UtcNow.ToString("O");

string UserEmail(HttpRequest request) => request.Headers["X-User-Email"].FirstOrDefault() is { Length: > 0 } email
    ? email
    : CurrentUserSession(request)?.Email is { Length: > 0 } sessionEmail
    ? sessionEmail
    : "demo.user@example.com";

UserSession? CurrentUserSession(HttpRequest request)
{
    var token = BearerToken(request);
    if (token.Length == 0 || !userSessions.TryGetValue(token, out var session)) return null;
    if (session.Expires < DateTimeOffset.UtcNow)
    {
        userSessions.TryRemove(token, out _);
        return null;
    }
    return session;
}

Dictionary<string, object?>? CurrentAuthUser(HttpRequest request)
{
    var session = CurrentUserSession(request);
    if (session is null) return null;
    return new()
    {
        ["email"] = session.Email,
        ["displayName"] = session.DisplayName,
        ["authType"] = session.AuthType,
        ["role"] = session.Role,
        ["expiresAt"] = session.Expires.ToString("O")
    };
}

string BearerToken(HttpRequest request)
{
    var value = request.Headers.Authorization.FirstOrDefault() ?? "";
    const string prefix = "Bearer ";
    return value.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? value[prefix.Length..].Trim() : "";
}

string CreateUserSession(string email, string displayName, string authType, string role = "student")
{
    var token = Token();
    userSessions[token] = new UserSession(email, displayName, authType, role, DateTimeOffset.UtcNow.AddSeconds(userSessionTtlSeconds));
    return token;
}

string NormalizeEmail(string email) => email.Trim().ToLowerInvariant();

string ResolveLoginId(string value)
{
    var login = value.Trim();
    if (login.Equals("admin", StringComparison.OrdinalIgnoreCase)) return "admin@example.local";
    return NormalizeEmail(login);
}

string HashPassword(string password)
{
    var salt = RandomNumberGenerator.GetBytes(16);
    var hash = Rfc2898DeriveBytes.Pbkdf2(password, salt, 100_000, HashAlgorithmName.SHA256, 32);
    return $"pbkdf2$100000${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
}

bool VerifyPassword(string password, string stored)
{
    var parts = stored.Split('$');
    if (parts.Length != 4 || parts[0] != "pbkdf2") return false;
    var iterations = int.Parse(parts[1]);
    var salt = Convert.FromBase64String(parts[2]);
    var expected = Convert.FromBase64String(parts[3]);
    var actual = Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, HashAlgorithmName.SHA256, expected.Length);
    return CryptographicOperations.FixedTimeEquals(actual, expected);
}

void EnsureUser(SqliteConnection conn, string email, string displayName, string authType)
{
    if (Rows(conn, "SELECT 1 FROM appUsers WHERE email=$email", new() { ["$email"] = email }).Any())
    {
        Exec(conn, "UPDATE appUsers SET displayName=$displayName,lastLoginAt=$lastLoginAt WHERE email=$email",
            new() { ["$displayName"] = displayName, ["$lastLoginAt"] = NowIso(), ["$email"] = email });
        return;
    }
    Exec(conn,
        "INSERT INTO appUsers(email,displayName,passwordHash,authType,role,status,createdAt,lastLoginAt) VALUES($email,$displayName,'',$authType,'student','active',$createdAt,$lastLoginAt)",
        new() { ["$email"] = email, ["$displayName"] = displayName, ["$authType"] = authType, ["$createdAt"] = NowIso(), ["$lastLoginAt"] = NowIso() });
}

string WindowsEmail(string windowsName)
{
    var name = windowsName.Trim();
    if (name.Contains('@')) return NormalizeEmail(name);
    var user = name.Split('\\', '/').LastOrDefault() ?? name;
    return NormalizeEmail($"{user}@windows.local");
}

object? ParseJsonObject(string json)
{
    try { return JsonNode.Parse(json); }
    catch { return new JsonObject(); }
}

bool Truthy(object? value)
{
    if (value is null) return false;
    var text = value.ToString()?.Trim().ToLowerInvariant() ?? "";
    return value is bool b ? b : text is "true" or "1" or "yes" or "y" or "on";
}

string S(JsonObject payload, string field, string fallback = "") =>
    payload.TryGetPropertyValue(field, out var value) && value is not null ? value.ToString() : fallback;

int I(JsonObject payload, string field, int fallback = 0)
{
    var value = S(payload, field);
    return int.TryParse(value, out var parsed) ? parsed : fallback;
}

string Required(JsonObject payload, string field, string label)
{
    var value = S(payload, field).Trim();
    if (value.Length == 0) throw new AppError($"{label} is required.");
    return value;
}

string ObjString(Dictionary<string, object?> row, string field, string fallback = "") =>
    row.TryGetValue(field, out var value) && value is not null ? value.ToString() ?? fallback : fallback;

int ObjInt(Dictionary<string, object?> row, string field, int fallback = 0)
{
    var value = ObjString(row, field);
    return int.TryParse(value, out var parsed) ? parsed : fallback;
}

void RequireAdmin(JsonObject payload)
{
    var token = S(payload, "token");
    if (token.Length == 0 || !sessions.TryGetValue(token, out var session))
        throw new AppError("Admin session expired. Sign in again.");
    if (session.Expires < DateTimeOffset.UtcNow)
    {
        sessions.TryRemove(token, out _);
        throw new AppError("Admin session expired. Sign in again.");
    }
}

string Token()
{
    Span<byte> bytes = stackalloc byte[24];
    RandomNumberGenerator.Fill(bytes);
    return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

string SafeId(string value, string prefix)
{
    var chars = new StringBuilder();
    foreach (var ch in value ?? "")
    {
        chars.Append(char.IsLetterOrDigit(ch) ? char.ToLowerInvariant(ch) : ' ');
    }
    var baseId = string.Join("_", chars.ToString().Split(' ', StringSplitOptions.RemoveEmptyEntries));
    if (baseId.Length > 40) baseId = baseId[..40];
    if (baseId.Length == 0) baseId = Guid.NewGuid().ToString("N")[..8];
    return $"{prefix}_{baseId}_{Guid.NewGuid().ToString("N")[..6]}";
}

string JsonText(JsonNode? value)
{
    if (value is null) return "{}";
    var text = value is JsonValue ? value.ToString() : value.ToJsonString();
    if (string.IsNullOrWhiteSpace(text)) text = "{}";
    JsonNode.Parse(text);
    return text;
}

int NextOrder(SqliteConnection conn, string table, string where = "", Dictionary<string, object?>? parameters = null)
{
    var sql = $"SELECT COALESCE(MAX(displayOrder),0) AS value FROM {table}";
    if (where.Length > 0) sql += " WHERE " + where;
    return ObjInt(Rows(conn, sql, parameters).First(), "value") + 1;
}

Dictionary<string, object?> ModulePayload(JsonObject payload, int currentOrder)
{
    var moduleType = S(payload, "moduleType") == "assessment" ? "assessment" : "learning";
    var timed = Truthy(S(payload, "isTimed"));
    return new()
    {
        ["$courseId"] = Required(payload, "courseId", "Course"),
        ["$title"] = Required(payload, "title", "Module title"),
        ["$description"] = S(payload, "description"),
        ["$displayOrder"] = I(payload, "displayOrder", currentOrder == 0 ? 1 : currentOrder),
        ["$status"] = S(payload, "status", "active"),
        ["$moduleType"] = moduleType,
        ["$maxAttempts"] = moduleType == "assessment" ? I(payload, "maxAttempts", 1) : null,
        ["$passingScore"] = moduleType == "assessment" ? I(payload, "passingScore") : null,
        ["$reviewMode"] = moduleType == "assessment" ? S(payload, "reviewMode", "mixed") : null,
        ["$lockAfterSubmit"] = moduleType == "assessment" ? Truthy(S(payload, "lockAfterSubmit", "true")).ToString() : null,
        ["$isTimed"] = moduleType == "assessment" ? timed.ToString() : null,
        ["$timeLimitMinutes"] = moduleType == "assessment" && timed ? I(payload, "timeLimitMinutes", 1) : null
    };
}

Dictionary<string, object?> ActivityPayload(JsonObject payload, Dictionary<string, object?> module, int currentOrder)
{
    var activityType = Required(payload, "activityType", "Activity type");
    ValidateActivityType(module, activityType);
    var assessment = ObjString(module, "moduleType") == "assessment";
    return new()
    {
        ["$courseId"] = ObjString(module, "courseId"),
        ["$moduleId"] = ObjString(module, "moduleId"),
        ["$activityType"] = activityType,
        ["$title"] = S(payload, "title"),
        ["$content"] = S(payload, "content"),
        ["$configJson"] = JsonText(payload["configJson"]),
        ["$displayOrder"] = I(payload, "displayOrder", currentOrder == 0 ? 1 : currentOrder),
        ["$status"] = S(payload, "status", "active"),
        ["$validationJson"] = JsonText(payload["validationJson"]),
        ["$points"] = assessment ? I(payload, "points") : null,
        ["$manualReviewRequired"] = assessment ? Truthy(S(payload, "manualReviewRequired")).ToString() : null
    };
}

void ValidateActivityType(Dictionary<string, object?> module, string activityType)
{
    var learning = new HashSet<string> { "html_content", "text", "content", "image", "practice_quiz", "drag_mapping", "drag_order", "sql_practice", "python_practice" };
    var assessment = new HashSet<string> { "quiz", "sql_task", "python_task", "open_answer" };
    var allowed = ObjString(module, "moduleType") == "assessment" ? assessment : learning;
    if (!allowed.Contains(activityType))
        throw new AppError($"Activity type {activityType} is not allowed for module type {ObjString(module, "moduleType")}.");
}

int ActivityInsertOrder(SqliteConnection conn, string moduleId, JsonObject payload)
{
    var items = Rows(conn, "SELECT activityId FROM activities WHERE moduleId=$moduleId AND status='active' ORDER BY displayOrder",
        new() { ["$moduleId"] = moduleId }).Select(x => ObjString(x, "activityId")).ToList();
    var position = items.Count;
    var before = S(payload, "insertBeforeActivityId");
    var after = S(payload, "insertAfterActivityId");
    if (before.Length > 0 && items.Contains(before)) position = items.IndexOf(before);
    else if (after.Length > 0 && items.Contains(after)) position = items.IndexOf(after) + 1;

    for (var i = position; i < items.Count; i++)
        Exec(conn, "UPDATE activities SET displayOrder=$displayOrder WHERE activityId=$activityId",
            new() { ["$displayOrder"] = i + 2, ["$activityId"] = items[i] });
    return position + 1;
}

void NormalizeActivityOrders(SqliteConnection conn, string moduleId)
{
    var items = Rows(conn, "SELECT activityId FROM activities WHERE moduleId=$moduleId AND status='active' ORDER BY displayOrder",
        new() { ["$moduleId"] = moduleId });
    for (var i = 0; i < items.Count; i++)
        Exec(conn, "UPDATE activities SET displayOrder=$displayOrder WHERE activityId=$activityId",
            new() { ["$displayOrder"] = i + 1, ["$activityId"] = ObjString(items[i], "activityId") });
}

void UpdateOrder(SqliteConnection conn, string table, string idColumn, List<string> ordered)
{
    for (var i = 0; i < ordered.Count; i++)
        Exec(conn, $"UPDATE {table} SET displayOrder=$displayOrder WHERE {idColumn}=$id",
            new() { ["$displayOrder"] = i + 1, ["$id"] = ordered[i] });
}

int EffectiveMaxAttempts(Dictionary<string, object?> module, List<Dictionary<string, object?>> overrides)
{
    var max = ObjInt(module, "maxAttempts", 1);
    foreach (var item in overrides)
        max = Math.Max(max, ObjInt(item, "maxAttemptsOverride", max));
    return max;
}

Dictionary<string, object?> SessionResponse(Dictionary<string, object?> session) => new()
{
    ["status"] = ObjString(session, "status", "active"),
    ["sessionId"] = ObjString(session, "sessionId"),
    ["startedAt"] = ObjString(session, "startedAt"),
    ["expiresAt"] = ObjString(session, "expiresAt"),
    ["attemptNo"] = ObjInt(session, "attemptNo", 1)
};

List<Dictionary<string, object?>> BuildAssessmentProgress(
    List<Dictionary<string, object?>> modules,
    List<Dictionary<string, object?>> attempts,
    List<Dictionary<string, object?>> overrides,
    List<Dictionary<string, object?>> attemptSessions)
{
    var result = new List<Dictionary<string, object?>>();
    foreach (var module in modules.Where(x => ObjString(x, "moduleType") == "assessment"))
    {
        var moduleId = ObjString(module, "moduleId");
        var moduleAttempts = attempts.Where(a => ObjString(a, "assessmentBlockId") == moduleId).ToList();
        var moduleOverrides = overrides.Where(o => ObjString(o, "assessmentBlockId") == moduleId).ToList();
        var max = EffectiveMaxAttempts(module, moduleOverrides);
        var last = moduleAttempts.LastOrDefault();
        var activeSession = attemptSessions.FirstOrDefault(s => ObjString(s, "moduleId") == moduleId && ObjString(s, "status") == "active");
        result.Add(new()
        {
            ["moduleId"] = moduleId,
            ["attemptsUsed"] = moduleAttempts.Count,
            ["effectiveMaxAttempts"] = max,
            ["remainingAttempts"] = Math.Max(max - moduleAttempts.Count, 0),
            ["canSubmit"] = moduleAttempts.Count < max,
            ["canStart"] = moduleAttempts.Count < max && activeSession is null,
            ["isTimed"] = Truthy(ObjString(module, "isTimed")),
            ["timeLimitMinutes"] = ObjInt(module, "timeLimitMinutes"),
            ["activeAttempt"] = activeSession is null ? null : SessionResponse(activeSession),
            ["lastResultStatus"] = last is null ? "" : ObjString(last, "resultStatus"),
            ["lastScorePercent"] = last is null ? 0 : ObjInt(last, "scorePercent")
        });
    }
    return result;
}

void FinalizeExpiredSessions(SqliteConnection conn, string userEmail, List<Dictionary<string, object?>> modules, List<Dictionary<string, object?>> activities)
{
    var active = Rows(conn, "SELECT * FROM assessmentAttemptSessions WHERE userEmail=$userEmail AND status='active'",
        new() { ["$userEmail"] = userEmail });
    foreach (var session in active)
    {
        if (DateTimeOffset.Parse(ObjString(session, "expiresAt")) > DateTimeOffset.UtcNow) continue;
        var module = modules.FirstOrDefault(m => ObjString(m, "moduleId") == ObjString(session, "moduleId") && ObjString(m, "moduleType") == "assessment");
        if (module is null) continue;
        if (Rows(conn, "SELECT 1 FROM assessmentAttempts WHERE sessionId=$sessionId", new() { ["$sessionId"] = ObjString(session, "sessionId") }).Any())
        {
            Exec(conn, "UPDATE assessmentAttemptSessions SET status='submitted' WHERE sessionId=$sessionId", new() { ["$sessionId"] = ObjString(session, "sessionId") });
            continue;
        }
        var tasks = activities.Where(a => ObjString(a, "moduleId") == ObjString(module, "moduleId")).OrderBy(OrderValue).ToList();
        var overrides = ActiveRows(Rows(conn, "SELECT * FROM assessmentAttemptOverrides WHERE userEmail=$userEmail AND assessmentBlockId=$moduleId",
            new() { ["$userEmail"] = userEmail, ["$moduleId"] = ObjString(module, "moduleId") })).ToList();
        var maxAttempts = EffectiveMaxAttempts(module, overrides);
        CompleteAssessmentAttempt(conn, module, tasks, userEmail, ObjInt(session, "attemptNo", 1), new JsonArray(), "time_expired", session, maxAttempts);
    }
}

Dictionary<string, object?> CompleteAssessmentAttempt(
    SqliteConnection conn,
    Dictionary<string, object?> module,
    List<Dictionary<string, object?>> tasks,
    string userEmail,
    int attemptNo,
    JsonArray taskResults,
    string reason,
    Dictionary<string, object?>? session,
    int maxAttempts)
{
    var results = new Dictionary<string, JsonObject>();
    foreach (var node in taskResults)
    {
        if (node is JsonObject obj)
        {
            var id = S(obj, "activityId");
            if (id.Length > 0) results[id] = obj;
        }
    }

    var score = 0;
    var maxScore = 0;
    var pendingReview = false;
    var failed = false;

    foreach (var task in tasks)
    {
        var activityId = ObjString(task, "activityId");
        results.TryGetValue(activityId, out var result);
        var validationStatus = result is null ? "not_checked" : S(result, "validationStatus");
        score += result is null ? 0 : I(result, "score");
        maxScore += ObjInt(task, "points");
        if (Truthy(ObjString(task, "manualReviewRequired")) || validationStatus == "pending_review") pendingReview = true;
        if (validationStatus is "failed" or "error" or "not_checked") failed = true;
    }

    var percent = maxScore > 0 ? (int)Math.Round(score * 100.0 / maxScore) : 0;
    var resultStatus = pendingReview ? "pending_review" : (!failed && percent >= ObjInt(module, "passingScore") ? "passed" : "failed");
    var attemptId = "att_" + Guid.NewGuid().ToString("N");
    Exec(conn,
        "INSERT INTO assessmentAttempts(attemptId,userEmail,courseId,assessmentBlockId,attemptNo,totalScore,maxScore,scorePercent,resultStatus,submittedAt,lockedAfterSubmit,submissionReason,sessionId) VALUES($attemptId,$userEmail,$courseId,$assessmentBlockId,$attemptNo,$totalScore,$maxScore,$scorePercent,$resultStatus,$submittedAt,$lockedAfterSubmit,$submissionReason,$sessionId)",
        new()
        {
            ["$attemptId"] = attemptId,
            ["$userEmail"] = userEmail,
            ["$courseId"] = ObjString(module, "courseId"),
            ["$assessmentBlockId"] = ObjString(module, "moduleId"),
            ["$attemptNo"] = attemptNo,
            ["$totalScore"] = score,
            ["$maxScore"] = maxScore,
            ["$scorePercent"] = percent,
            ["$resultStatus"] = resultStatus,
            ["$submittedAt"] = NowIso(),
            ["$lockedAfterSubmit"] = ObjString(module, "lockAfterSubmit"),
            ["$submissionReason"] = reason,
            ["$sessionId"] = session is null ? "" : ObjString(session, "sessionId")
        });

    foreach (var task in tasks)
    {
        var activityId = ObjString(task, "activityId");
        results.TryGetValue(activityId, out var result);
        Exec(conn,
            "INSERT INTO assessmentTaskAttempts(taskAttemptId,attemptId,userEmail,assessmentBlockId,assessmentTaskId,taskType,answerJson,interpreterStatus,interpreterOutput,validationStatus,validationOutput,score,manualReviewRequired) VALUES($taskAttemptId,$attemptId,$userEmail,$assessmentBlockId,$assessmentTaskId,$taskType,$answerJson,$interpreterStatus,$interpreterOutput,$validationStatus,$validationOutput,$score,$manualReviewRequired)",
            new()
            {
                ["$taskAttemptId"] = "tatt_" + Guid.NewGuid().ToString("N"),
                ["$attemptId"] = attemptId,
                ["$userEmail"] = userEmail,
                ["$assessmentBlockId"] = ObjString(module, "moduleId"),
                ["$assessmentTaskId"] = activityId,
                ["$taskType"] = ObjString(task, "activityType"),
                ["$answerJson"] = result?["answer"]?.ToJsonString() ?? "{}",
                ["$interpreterStatus"] = result is null ? "" : S(result, "interpreterStatus"),
                ["$interpreterOutput"] = result is null ? "" : S(result, "interpreterOutput"),
                ["$validationStatus"] = result is null ? "not_checked" : S(result, "validationStatus"),
                ["$validationOutput"] = result is null ? "" : S(result, "validationOutput"),
                ["$score"] = result is null ? 0 : I(result, "score"),
                ["$manualReviewRequired"] = ObjString(task, "manualReviewRequired")
            });
    }

    if (session is not null)
    {
        Exec(conn, "UPDATE assessmentAttemptSessions SET status='submitted', submittedAt=$submittedAt, submissionReason=$submissionReason WHERE sessionId=$sessionId",
            new() { ["$submittedAt"] = NowIso(), ["$submissionReason"] = reason, ["$sessionId"] = ObjString(session, "sessionId") });
    }

    return new()
    {
        ["status"] = "submitted",
        ["attemptNo"] = attemptNo,
        ["effectiveMaxAttempts"] = maxAttempts,
        ["totalScore"] = score,
        ["maxScore"] = maxScore,
        ["scorePercent"] = percent,
        ["resultStatus"] = resultStatus,
        ["submissionReason"] = reason
    };
}

List<string> StringArray(JsonObject payload, string field) =>
    payload[field] is JsonArray arr ? arr.Select(x => x?.ToString() ?? "").Where(x => x.Length > 0).ToList() : new List<string>();

Dictionary<string, object?> ParamDict(Dictionary<string, object?> values) =>
    values.ToDictionary(x => "$" + x.Key, x => x.Value);

record AdminSession(string Username, DateTimeOffset Expires);
record UserSession(string Email, string DisplayName, string AuthType, string Role, DateTimeOffset Expires);

class AppError(string message) : Exception(message);

static class DictionaryExtensions
{
    public static Dictionary<string, object?> With(this Dictionary<string, object?> source, string key, object? value)
    {
        source[key] = value;
        return source;
    }
}
