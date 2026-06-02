let state = {
  data: null,
  selectedCourse: localStorage.getItem("selectedCourse") || "",
  selectedModule: localStorage.getItem("selectedModule") || "",
  adminToken: localStorage.getItem("adminToken") || "",
  adminUser: localStorage.getItem("adminUser") || "",
  sqlRuntime: {},
  pythonRuntime: {},
  dragItem: null,
  richTextEditors: {},
  countdownId: null,
  timedSubmitStarted: false,
  pythonPreload: "idle",
  authToken: localStorage.getItem("authToken") || "",
  authUser: parseJson(localStorage.getItem("authUser"), null),
  draftTimers: {},
  authMode: "login",
  restoreScrollPending: true,
  scrollTimer: null
};

let SQL = null;
let PYODIDE = null;
let pyodidePromise = null;

const $ = (id) => document.getElementById(id);

async function api(path, method = "GET", body) {
  const headers = { "Content-Type": "application/json" };
  if (state.authToken) headers.Authorization = `Bearer ${state.authToken}`;
  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await res.json();
  if (!res.ok) throw new Error(payload.error || "API error");
  return payload;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}

function css(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function shuffle(items) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function isActive(row) {
  return String(row.status || "").toLowerCase() === "active";
}

function byOrder(a, b) {
  return Number(a.displayOrder || 0) - Number(b.displayOrder || 0);
}

function truthy(v) {
  return v === true || ["true", "1", "yes", "on"].includes(String(v).toLowerCase());
}

function isSafeMediaUrl(url) {
  return /^(https?:\/\/|\/)/i.test(String(url || "").trim());
}

function isDirectVideoUrl(url) {
  return /\.(mp4|webm|ogg|mov|m4v)(\?.*)?$/i.test(String(url || "").trim());
}

function embeddableVideoUrl(url) {
  const raw = String(url || "").trim();
  try {
    const parsed = new URL(raw, window.location.origin);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    let videoId = "";

    if (host === "youtu.be") {
      videoId = parsed.pathname.split("/").filter(Boolean)[0] || "";
    } else if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com" || host === "youtube-nocookie.com") {
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parsed.pathname === "/watch") videoId = parsed.searchParams.get("v") || "";
      else if (parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live") videoId = parts[1] || "";
    }

    if (videoId) {
      const embed = new URL(`https://www.youtube-nocookie.com/embed/${videoId}`);
      const start = parsed.searchParams.get("start") || parsed.searchParams.get("t");
      if (start) embed.searchParams.set("start", String(start).replace(/[^\d]/g, ""));
      return embed.toString();
    }

    if (host === "vimeo.com") {
      const videoPath = parsed.pathname.split("/").filter(Boolean).find((part) => /^\d+$/.test(part));
      if (videoPath) return `https://player.vimeo.com/video/${videoPath}`;
    }
  } catch {
    return raw;
  }
  return raw;
}

function normalize(payload) {
  payload.courses = payload.courses || [];
  payload.modules = payload.modules || [];
  payload.activities = payload.activities || [];
  payload.sqlSchemas = payload.sqlSchemas || [];
  payload.assessmentProgress = payload.assessmentProgress || [];
  payload.drafts = payload.drafts || [];
  if (payload.authUser) {
    state.authUser = payload.authUser;
    localStorage.setItem("authUser", JSON.stringify(payload.authUser));
  }
  payload.activities.forEach((a) => {
    a.config = parseJson(a.configJson, {});
    a.validation = parseJson(a.validationJson, {});
  });
  return payload;
}

function modules() {
  return state.data.modules.filter((m) => m.courseId === state.selectedCourse && isActive(m)).sort(byOrder);
}

function activities(moduleId) {
  return state.data.activities.filter((a) => a.moduleId === moduleId && isActive(a)).sort(byOrder);
}

function findActivity(id) {
  return state.data.activities.find((a) => a.activityId === id);
}

function getDraft(activityId) {
  return (state.data?.drafts || []).find((d) => d.activityId === activityId)?.answer || null;
}

function setDraftLocal(moduleId, activityId, answer) {
  state.data.drafts = (state.data.drafts || []).filter((d) => d.activityId !== activityId);
  state.data.drafts.push({ moduleId, activityId, answer, updatedAt: new Date().toISOString() });
}

function saveDraft(moduleId, activityId, answer) {
  if (!state.authToken) return;
  setDraftLocal(moduleId, activityId, answer);
  clearTimeout(state.draftTimers[activityId]);
  state.draftTimers[activityId] = setTimeout(() => {
    api("/api/draft/save", "POST", { moduleId, activityId, answer }).catch((e) => console.warn("Draft save failed", e));
  }, 500);
}

function collectDraftAnswer(activity) {
  if (activity.activityType === "quiz") {
    const answers = {};
    (activity.config.questions || []).forEach((q, i) => {
      answers[i] = [...document.querySelectorAll(`[name="q_${css(activity.activityId)}_${i}"]:checked`)].map((n) => Number(n.value)).sort();
    });
    return { type: "quiz", answers };
  }
  if (activity.activityType === "open_answer") {
    return { type: "open_answer", text: $(`open_${activity.activityId}`)?.value || "" };
  }
  if (activity.activityType === "sql_task") {
    const runtime = state.sqlRuntime[activity.activityId];
    return {
      type: "sql_task",
      query: $(`sql_${activity.activityId}`)?.value || "",
      rows: runtime?.normalized?.rows || [],
      validationStatus: runtime?.validationStatus || ""
    };
  }
  return {};
}

function getProgress(moduleId) {
  return state.data.assessmentProgress.find((p) => p.moduleId === moduleId);
}

function saveNavigationState() {
  if (state.selectedCourse) localStorage.setItem("selectedCourse", state.selectedCourse);
  if (state.selectedModule) localStorage.setItem("selectedModule", state.selectedModule);
}

function saveScrollPosition() {
  if (!state.authToken) return;
  clearTimeout(state.scrollTimer);
  state.scrollTimer = setTimeout(() => {
    localStorage.setItem("scrollY", String(Math.max(0, window.scrollY || document.documentElement.scrollTop || 0)));
  }, 120);
}

function restoreScrollOnce() {
  if (!state.restoreScrollPending) return;
  state.restoreScrollPending = false;
  const y = Number(localStorage.getItem("scrollY") || 0);
  if (y > 0) requestAnimationFrame(() => setTimeout(() => window.scrollTo({ top: y, left: 0, behavior: "auto" }), 0));
}

async function load() {
  if (!state.authToken) {
    showAuthGate();
    return;
  }
  stopCountdown();
  state.data = normalize(await api("/api/app-data"));
  if (!state.data.authUser) {
    clearSignedIn();
    showAuthGate("Session expired. Sign in again.");
    return;
  }
  showAppShell();
  warmPythonRuntime();
  const courses = state.data.courses.filter(isActive).sort(byOrder);
  if (!courses.length) {
    $("courses").innerHTML = "<p>No active courses configured.</p>";
    $("content").innerHTML = "";
    return;
  }
  if (!courses.some((c) => c.courseId === state.selectedCourse)) state.selectedCourse = courses[0].courseId;
  const ms = modules();
  if (!ms.some((m) => m.moduleId === state.selectedModule)) state.selectedModule = ms[0]?.moduleId || "";
  saveNavigationState();
  render();
  restoreScrollOnce();
}

function render() {
  renderSidebar();
  renderMain();
  renderAuth();
  renderPythonStatus();
  initAdminSorting();
}

function showAuthGate(message = "") {
  $("authGate").hidden = false;
  $("appHeader").hidden = true;
  $("appShell").hidden = true;
  $("authGate").classList.remove("hidden");
  $("appHeader").classList.add("hidden");
  $("appShell").classList.add("hidden");
  $("gateMsg").textContent = message;
  renderAuthGateMode();
}

function showAppShell() {
  $("authGate").hidden = true;
  $("appHeader").hidden = false;
  $("appShell").hidden = false;
  $("authGate").classList.add("hidden");
  $("appHeader").classList.remove("hidden");
  $("appShell").classList.remove("hidden");
}

function renderAuth() {
  const user = state.authUser;
  $("authStatus").textContent = user ? `${user.role === "admin" ? "Admin: " : ""}${user.displayName || user.email}` : "Guest";
  $("authStatus").className = `runtime-status ${user ? "ready" : ""}`;
  $("authBtn").textContent = "Выйти";
}

function renderSidebar() {
  const courses = state.data.courses.filter(isActive).sort(byOrder);
  $("courses").innerHTML = `
    <div class="side-head">Courses</div>
    <div class="nav-list" id="courseList">
      ${courses.map((c) => `
        <div class="admin-row course-sort-row" data-course-id="${esc(c.courseId)}">
          ${state.adminToken ? `<button class="sort-handle" title="Drag to reorder" draggable="true">::</button>` : ""}
          <button class="nav-card ${c.courseId === state.selectedCourse ? "active" : ""}" onclick="selectCourse('${esc(c.courseId)}')">
            <b>${esc(c.title)}</b>
            <span>${esc(c.category || c.level || "")}</span>
          </button>
          ${state.adminToken ? `<button class="icon-btn" title="Edit course" onclick="openCourseEditor('${esc(c.courseId)}')">E</button><button class="icon-btn danger" title="Delete course" onclick="deleteCourse('${esc(c.courseId)}')">X</button>` : ""}
        </div>
      `).join("")}
    </div>
    ${state.adminToken ? `<button class="btn ghost small full" onclick="openCourseEditor()">+ Add course</button>` : ""}
    <div class="side-head">Modules</div>
    <div class="nav-list" id="moduleList">
      ${modules().map((m) => `
        <div class="admin-row module-sort-row" data-module-id="${esc(m.moduleId)}">
          ${state.adminToken ? `<button class="sort-handle" title="Drag to reorder" draggable="true">::</button>` : ""}
          <button class="nav-card ${m.moduleId === state.selectedModule ? "active" : ""}" onclick="selectModule('${esc(m.moduleId)}')">
            <b>${esc(m.title)}</b>
            <span>${m.moduleType === "assessment" ? "Assessment" : "Learning"}</span>
          </button>
          ${state.adminToken ? `<button class="icon-btn" title="Edit module" onclick="openModuleEditor('${esc(m.moduleId)}')">E</button><button class="icon-btn danger" title="Delete module" onclick="deleteModule('${esc(m.moduleId)}')">X</button>` : ""}
        </div>
      `).join("")}
    </div>
    ${state.adminToken && state.selectedCourse ? `<button class="btn ghost small full" onclick="openModuleEditor()">+ Add module</button>` : ""}
  `;
}

function renderMain() {
  const module = state.data.modules.find((m) => m.moduleId === state.selectedModule);
  if (!module) {
    $("content").innerHTML = "<p class='muted'>Select a module.</p>";
    return;
  }
  const tasks = activities(module.moduleId);
  const body = module.moduleType === "assessment"
    ? renderAssessmentModule(module, tasks)
    : renderActivityList(module, tasks, false);

  $("content").innerHTML = `
    <section class="module-page">
      <div class="module-header">
        <div>
          <span class="badge ${module.moduleType === "assessment" ? "black" : ""}">${module.moduleType === "assessment" ? "Assessment module" : "Learning module"}</span>
          <h2>${esc(module.title)}</h2>
          <div class="muted">${esc(module.description || "")}</div>
        </div>
        ${state.adminToken ? `<button class="btn ghost small" onclick="openModuleEditor('${esc(module.moduleId)}')">Edit module</button>` : ""}
      </div>
      ${body || "<div class='result warn'>No activities in this module yet.</div>"}
      ${state.adminToken && !tasks.length ? `<button class="btn ghost small full" onclick="openActivityEditor('${esc(module.moduleId)}')">+ Add activity</button>` : ""}
    </section>
  `;
  initInteractiveActivities();
  applyDrafts(module.moduleId);
}

function renderActivityList(module, tasks, assessment) {
  const items = [];
  if (state.adminToken) items.push(renderInsertZone(module.moduleId, { before: tasks[0]?.activityId || "" }));
  tasks.forEach((activity) => {
    items.push(renderBrick(activity, assessment));
    if (state.adminToken) items.push(renderInsertZone(module.moduleId, { after: activity.activityId }));
  });
  return `<div id="activityList">${items.join("")}</div>`;
}

function renderInsertZone(moduleId, position) {
  const before = position.before || "";
  const after = position.after || "";
  const label = before ? "+ Add activity here" : "+ Add activity below";
  return `<div class="insert-zone"><button onclick="openActivityEditor('${esc(moduleId)}','','${esc(before)}','${esc(after)}')">${label}</button></div>`;
}

function renderBrick(activity, assessment) {
  return `
    <div class="activity-unit activity-sort-row" id="brick_${esc(activity.activityId)}" data-activity-id="${esc(activity.activityId)}">
      ${state.adminToken ? `
        <div class="brick-admin">
          <button class="sort-handle activity-handle" title="Drag to reorder" draggable="true">::</button>
          <button class="btn ghost small" onclick="openActivityEditor('${esc(activity.moduleId)}','${esc(activity.activityId)}')">Edit</button>
          <button class="btn danger small" onclick="deleteActivity('${esc(activity.activityId)}')">Delete</button>
        </div>
      ` : ""}
      <div class="brick">
        <div class="brick-surface">${renderActivity(activity, assessment)}</div>
      </div>
    </div>
  `;
}

function renderActivity(a, assessment) {
  if (a.activityType === "html_content" || a.activityType === "content") return sanitizeRichHtml(a.content || "");
  if (a.activityType === "text") {
    const html = a.config.html || `<h2>${esc(a.config.heading || "")}</h2><p>${esc(a.config.text || "").replace(/\n/g, "<br>")}</p>`;
    return `<div class="rich-text-brick">${sanitizeRichHtml(html)}</div>`;
  }
  if (a.activityType === "image") return renderImage(a);
  if (a.activityType === "video") return renderVideo(a);
  if (a.activityType === "practice_quiz" || a.activityType === "quiz") return renderQuiz(a, assessment);
  if (a.activityType === "drag_mapping") return renderMapping(a);
  if (a.activityType === "drag_order") return renderOrder(a);
  if (a.activityType === "sql_practice" || a.activityType === "sql_task") return renderSql(a);
  if (a.activityType === "python_practice" || a.activityType === "python_task") return renderPython(a);
  if (a.activityType === "open_answer") return renderOpenAnswer(a);
  if (a.activityType === "assessment_block") return `<div class="result warn">Assessment block is represented by the module itself in this version.</div>`;
  return `<div class="result warn">Unsupported activity type: ${esc(a.activityType)}</div>`;
}

function renderImage(a) {
  return `
    <figure class="image-block">
      <img src="${esc(a.config.imageUrl || "")}" alt="${esc(a.config.caption || a.title || "")}">
      ${a.config.caption ? `<figcaption>${esc(a.config.caption)}</figcaption>` : ""}
    </figure>
  `;
}

function renderVideo(a) {
  const cfg = a.config || {};
  const url = String(cfg.videoUrl || "").trim();
  const poster = String(cfg.posterUrl || "").trim();
  const caption = cfg.caption || "";
  const mode = cfg.sourceType || (isDirectVideoUrl(url) ? "file" : "embed");
  const embedUrl = embeddableVideoUrl(url);
  const shouldEmbed = mode === "embed" || embedUrl !== url;

  if (!url) return `<div class="result warn">Video URL is not configured.</div>`;
  if (!isSafeMediaUrl(url)) return `<div class="result error">Video URL must start with http(s):// or /.</div>`;

  const media = !shouldEmbed && (mode === "file" || isDirectVideoUrl(url))
    ? `<video controls preload="metadata" ${poster && isSafeMediaUrl(poster) ? `poster="${esc(poster)}"` : ""}>
        <source src="${esc(url)}">
        Your browser does not support the video tag.
      </video>`
    : `<iframe src="${esc(embedUrl)}" title="${esc(a.title || caption || "Video")}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen loading="lazy"></iframe>`;

  return `
    <figure class="video-block">
      <div class="video-frame">${media}</div>
      ${caption ? `<figcaption>${esc(caption)}</figcaption>` : ""}
    </figure>
  `;
}

function renderQuiz(a, assessment) {
  const questions = a.config.questions || [];
  return `
    <div class="task-card">
      <h3>${esc(a.title || (assessment ? "Quiz" : "Practice quiz"))}</h3>
      ${a.config.intro ? `<div class="muted">${esc(a.config.intro)}</div>` : ""}
      ${questions.map((q, i) => `
        <div class="question-card">
          <b>${i + 1}. ${esc(q.question)}</b>
          ${(q.options || []).map((opt, j) => `
            <label class="option">
              <input type="${(q.correctAnswers || []).length > 1 ? "checkbox" : "radio"}" name="q_${esc(a.activityId)}_${i}" value="${j}">
              <span>${esc(opt)}</span>
            </label>
          `).join("")}
        </div>
      `).join("")}
      ${!assessment ? `<button class="btn" onclick="checkPractice('${esc(a.activityId)}')">Check answers</button><div id="result_${esc(a.activityId)}"></div>` : ""}
    </div>
  `;
}

function renderMapping(a) {
  const cfg = a.config || {};
  const rightItems = shuffle(cfg.rightItems || []);
  return `
    <div class="task-card">
      <div class="drag-grid">
        <div class="drag-box">
          <h3>${esc(cfg.rightTitle || "Values")}</h3>
          <div class="drop-zone pool">
            ${rightItems.map((v) => `<div class="drag-item" draggable="true" data-value="${esc(v)}">${esc(v)}</div>`).join("")}
          </div>
        </div>
        <div class="drag-box">
          <h3>${esc(cfg.leftTitle || "Targets")}</h3>
          ${(cfg.leftItems || []).map((v) => `<b>${esc(v)}</b><div class="drop-zone mapping-zone" data-target="${esc(v)}"></div>`).join("")}
        </div>
      </div>
      <button class="btn" onclick="checkMapping('${esc(a.activityId)}')">Check mapping</button>
      <div id="result_${esc(a.activityId)}"></div>
    </div>
  `;
}

function renderOrder(a) {
  const cfg = a.config || {};
  const steps = shuffle(cfg.steps || cfg.correctOrder || []);
  return `
    <div class="task-card">
      <h3>${esc(cfg.question || a.title || "Put steps in order")}</h3>
      <div class="muted">Order is read from top to bottom.</div>
      <div class="order-list" id="order_${esc(a.activityId)}">
        ${steps.map((s) => `
          <div class="drag-item order-item" draggable="true" data-value="${esc(s)}">
            <span class="order-number"></span>
            <span>${esc(s)}</span>
          </div>`).join("")}
      </div>
      <button class="btn" onclick="checkOrder('${esc(a.activityId)}')">Check order</button>
      <div id="result_${esc(a.activityId)}"></div>
    </div>
  `;
}

function renderSql(a) {
  return `
    <div class="task-card">
      <h3>${esc(a.title || "SQL task")}</h3>
      <div class="muted">${esc(a.config.instructions || a.content || "")}</div>
      <div class="sql-controls">
        <button class="btn ghost small" id="db_btn_${esc(a.activityId)}" onclick="toggleTables('${esc(a.activityId)}','${esc(a.config.databaseSchemaId || "")}')">View demo tables</button>
      </div>
      <div id="db_${esc(a.activityId)}"></div>
      <div class="field"><textarea class="sql-editor" id="sql_${esc(a.activityId)}">${esc(a.config.defaultQuery || "")}</textarea></div>
      <button class="btn" onclick="runSql('${esc(a.activityId)}')">Run SQL</button>
      <div id="sql_error_${esc(a.activityId)}"></div>
      <div id="sql_result_${esc(a.activityId)}" class="sql-table-wrap"></div>
    </div>
  `;
}

function renderPython(a) {
  return `
    <div class="task-card">
      <h3>${esc(a.title || "Python task")}</h3>
      <div class="muted">${esc(a.config.instructions || a.content || "")}</div>
      <div class="field"><textarea class="python-editor" id="python_${esc(a.activityId)}">${esc(a.config.starterCode || "")}</textarea></div>
      <button class="btn" onclick="runPython('${esc(a.activityId)}')">Run Python</button>
      <div id="python_error_${esc(a.activityId)}"></div>
      <div id="python_result_${esc(a.activityId)}"></div>
    </div>
  `;
}

function renderOpenAnswer(a) {
  return `
    <div class="task-card">
      <h3>${esc(a.title || "Open answer")}</h3>
      <div class="muted">${esc(a.content || "")}</div>
      <div class="field">
        <textarea id="open_${esc(a.activityId)}" placeholder="${esc(a.config.placeholder || "Write your answer...")}"></textarea>
      </div>
    </div>
  `;
}

function renderAssessmentModule(module, tasks) {
  const progress = getProgress(module.moduleId);
  const timed = truthy(module.isTimed);
  const activeAttempt = progress && progress.activeAttempt;
  const canSubmit = !progress || progress.canSubmit;
  const attemptsText = `${progress ? progress.attemptsUsed : 0} / ${progress ? progress.effectiveMaxAttempts : (module.maxAttempts || 1)}`;

  if (timed && !state.adminToken && !activeAttempt) {
    if (!canSubmit) {
      return `<div class="assessment-gate"><h3>${esc(module.title)}</h3><div class="muted">This assessment module is no longer available. Attempts used: ${esc(attemptsText)}.</div></div>`;
    }
    return `
      <div class="assessment-gate">
        <span class="badge black">Timed assessment</span>
        <h3>${esc(module.title)}</h3>
        <div class="muted">Time limit: ${esc(module.timeLimitMinutes || 1)} minute(s). The timer starts after you begin the attempt.</div>
        <div class="badge grey">Attempts: ${esc(attemptsText)}</div>
        <br>
        <button class="btn" onclick="startTimedAssessment('${esc(module.moduleId)}')">Start attempt</button>
        <div id="assessment_result"></div>
      </div>
    `;
  }

  const visibleTasks = tasks.filter((a) => a.activityType !== "assessment_block");
  const assessmentHtml = `
    <div class="assessment">
      <div class="assessment-intro">
        <h3>${esc(module.title)}</h3>
        <div class="muted">One submit consumes one attempt. Passing score: ${esc(module.passingScore || 0)}%.</div>
        <div class="badge grey">Attempts: ${esc(attemptsText)}</div>
        ${timed && activeAttempt && !state.adminToken ? `<div class="assessment-timer"><span>Time remaining</span><span class="timer-value" id="assessment_timer">--:--</span></div>` : ""}
        ${timed && state.adminToken ? `<div class="badge grey">Timed: ${esc(module.timeLimitMinutes || 1)} min (admin preview)</div>` : ""}
      </div>
      ${renderActivityList(module, visibleTasks, true)}
      ${!state.adminToken ? `<button class="btn" ${canSubmit ? "" : "disabled"} onclick="submitAssessment('${esc(module.moduleId)}', false)">Submit assessment module</button><div id="assessment_result"></div>` : ""}
    </div>
  `;

  if (timed && activeAttempt && !state.adminToken) {
    setTimeout(() => beginCountdown(module.moduleId, activeAttempt.expiresAt), 0);
  } else {
    stopCountdown();
  }
  return assessmentHtml;
}

function sanitizeRichHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html || "");
  template.content.querySelectorAll("script,style,iframe,object,embed,svg,math,link,meta").forEach((el) => el.remove());
  template.content.querySelectorAll("*").forEach((el) => {
    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) el.removeAttribute(attr.name);
      if (el.tagName === "A" && name === "href") {
        const href = el.getAttribute("href") || "";
        if (!/^(https?:\/\/|mailto:|#)/i.test(href)) el.removeAttribute("href");
      }
      if (el.tagName !== "A" && ["target", "rel"].includes(name)) el.removeAttribute(attr.name);
    });
    if (el.tagName === "A" && /^https?:\/\//i.test(el.getAttribute("href") || "")) {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
  });
  return template.innerHTML;
}

function initInteractiveActivities() {
  document.querySelectorAll(".activity-unit").forEach((container) => initMappingDrag(container));
  document.querySelectorAll(".order-list").forEach((list) => initOrderDrag(list));
  initDraftListeners();
  refreshOrderNumbers();
}

function initDraftListeners() {
  if (!state.authToken) return;
  activities(state.selectedModule).forEach((activity) => {
    if (activity.activityType === "quiz") {
      document.querySelectorAll(`[name^="q_${css(activity.activityId)}_"]`).forEach((input) => {
        input.onchange = () => saveDraft(activity.moduleId, activity.activityId, collectDraftAnswer(activity));
      });
    } else if (activity.activityType === "open_answer") {
      const input = $(`open_${activity.activityId}`);
      if (input) input.oninput = () => saveDraft(activity.moduleId, activity.activityId, collectDraftAnswer(activity));
    } else if (activity.activityType === "sql_task") {
      const input = $(`sql_${activity.activityId}`);
      if (input) input.oninput = () => saveDraft(activity.moduleId, activity.activityId, collectDraftAnswer(activity));
    }
  });
}

function applyDrafts(moduleId) {
  if (!state.authToken) return;
  activities(moduleId).forEach((activity) => {
    const draft = getDraft(activity.activityId);
    if (!draft) return;
    if (activity.activityType === "quiz" && draft.answers) {
      Object.entries(draft.answers).forEach(([index, values]) => {
        document.querySelectorAll(`[name="q_${css(activity.activityId)}_${index}"]`).forEach((input) => {
          input.checked = (values || []).includes(Number(input.value));
        });
      });
    } else if (activity.activityType === "open_answer") {
      const input = $(`open_${activity.activityId}`);
      if (input && draft.text) input.value = draft.text;
    } else if (activity.activityType === "sql_task") {
      const input = $(`sql_${activity.activityId}`);
      if (input && draft.query) input.value = draft.query;
    }
  });
}

function initMappingDrag(container) {
  container.querySelectorAll(".drag-item:not(.order-item)").forEach((el) => {
    el.ondragstart = (event) => {
      state.dragItem = el;
      el.classList.add("dragging");
      if (event.dataTransfer) event.dataTransfer.setData("text/plain", el.dataset.value || "");
    };
    el.ondragend = () => {
      el.classList.remove("dragging");
      container.querySelectorAll(".drop-zone").forEach((zone) => zone.classList.remove("over"));
      state.dragItem = null;
    };
  });
  container.querySelectorAll(".drop-zone").forEach((zone) => {
    zone.ondragover = (event) => {
      event.preventDefault();
      zone.classList.add("over");
    };
    zone.ondragleave = () => zone.classList.remove("over");
    zone.ondrop = (event) => {
      event.preventDefault();
      zone.classList.remove("over");
      if (!state.dragItem) return;
      if (zone.classList.contains("mapping-zone")) {
        const existing = zone.querySelector(".drag-item");
        if (existing && existing !== state.dragItem) container.querySelector(".pool")?.appendChild(existing);
      }
      zone.appendChild(state.dragItem);
    };
  });
}

function initOrderDrag(list) {
  list.querySelectorAll(".order-item").forEach((item) => {
    item.ondragstart = () => {
      state.dragItem = item;
      item.classList.add("dragging");
    };
    item.ondragend = () => {
      item.classList.remove("dragging");
      state.dragItem = null;
      refreshOrderNumbers();
    };
  });
  list.ondragover = (event) => {
    event.preventDefault();
    const dragging = state.dragItem;
    if (!dragging || !dragging.classList.contains("order-item")) return;
    const after = [...list.querySelectorAll(".order-item:not(.dragging)")].find((item) => {
      const box = item.getBoundingClientRect();
      return event.clientY < box.top + box.height / 2;
    });
    if (after) list.insertBefore(dragging, after);
    else list.appendChild(dragging);
    refreshOrderNumbers();
  };
}

function refreshOrderNumbers() {
  document.querySelectorAll(".order-list").forEach((list) => {
    list.querySelectorAll(".order-number").forEach((node, i) => {
      node.textContent = String(i + 1);
    });
  });
}

async function checkPractice(id) {
  const a = findActivity(id);
  let correct = 0;
  (a.config.questions || []).forEach((q, i) => {
    const chosen = [...document.querySelectorAll(`[name="q_${css(id)}_${i}"]:checked`)].map((n) => Number(n.value)).sort();
    const expected = (q.correctAnswers || []).slice().sort();
    if (JSON.stringify(chosen) === JSON.stringify(expected)) correct += 1;
  });
  const total = (a.config.questions || []).length;
  const good = correct === total;
  showResult(`result_${id}`, `Result: ${correct} / ${total}. This does not consume attempts.`, good ? "ok" : "warn");
  await api("/api/learning-event", "POST", {
    courseId: a.courseId,
    activityId: a.activityId,
    activityType: a.activityType,
    answer: { correct },
    isCorrect: good
  }).catch(() => {});
}

function checkMapping(id) {
  const a = findActivity(id);
  const expected = a.config.correctMapping || {};
  let ok = 0;
  document.querySelectorAll(`#brick_${css(id)} .mapping-zone`).forEach((zone) => {
    const item = zone.querySelector(".drag-item");
    if (item && expected[zone.dataset.target] === item.dataset.value) ok += 1;
  });
  const total = Object.keys(expected).length;
  showResult(`result_${id}`, `Result: ${ok} / ${total}.`, ok === total ? "ok" : "warn");
}

function checkOrder(id) {
  const a = findActivity(id);
  const got = [...document.querySelectorAll(`#order_${css(id)} .drag-item`)].map((item) => item.dataset.value);
  const good = JSON.stringify(got) === JSON.stringify(a.config.correctOrder || []);
  showResult(`result_${id}`, good ? "Correct order." : "Incorrect order. Try again.", good ? "ok" : "warn");
}

async function loadSql() {
  if (window.initSqlJs) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.js";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Unable to load SQL runtime."));
    document.body.appendChild(script);
  });
}

async function dbFor(schemaId) {
  await loadSql();
  if (!SQL) {
    SQL = await initSqlJs({ locateFile: (file) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${file}` });
  }
  const schema = state.data.sqlSchemas.find((s) => s.schemaId === schemaId);
  if (!schema) throw new Error("SQL schema not found.");
  const db = new SQL.Database();
  db.run(schema.initSql);
  return db;
}

async function toggleTables(id, schemaId) {
  const box = $(`db_${id}`);
  const btn = $(`db_btn_${id}`);
  if (box.dataset.open === "true") {
    box.innerHTML = "";
    box.dataset.open = "false";
    btn.textContent = "View demo tables";
    return;
  }
  try {
    const db = await dbFor(schemaId);
    const namesResult = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const names = namesResult.length ? namesResult[0].values.map((row) => row[0]) : [];
    box.innerHTML = names.map((name) => `<div class="task-card table-card"><b>${esc(name)}</b>${tableHtml(normalizeSql(db.exec(`SELECT * FROM ${name}`)))}</div>`).join("");
    box.dataset.open = "true";
    btn.textContent = "Hide demo tables";
    db.close();
  } catch (e) {
    showResult(`db_${id}`, `Error: ${e.message}`, "error");
  }
}

async function runSql(id) {
  const a = findActivity(id);
  const error = $(`sql_error_${id}`);
  const result = $(`sql_result_${id}`);
  error.innerHTML = "";
  result.innerHTML = "";
  try {
    const db = await dbFor(a.config.databaseSchemaId);
    const query = $(`sql_${id}`).value;
    const normalized = normalizeSql(db.exec(query));
    result.innerHTML = tableHtml(normalized);
    state.sqlRuntime[id] = {
      query,
      normalized,
      interpreterStatus: "success",
      interpreterOutput: "",
      validationStatus: validateSql(a, normalized) ? "passed" : "failed"
    };
    saveDraft(a.moduleId, a.activityId, collectDraftAnswer(a));
    db.close();
  } catch (e) {
    error.innerHTML = `<div class="result error">Interpreter error: ${esc(e.message)}</div>`;
    state.sqlRuntime[id] = {
      query: $(`sql_${id}`)?.value || "",
      interpreterStatus: "error",
      interpreterOutput: e.message,
      validationStatus: "not_checked",
      normalized: { columns: [], rows: [] }
    };
    saveDraft(a.moduleId, a.activityId, collectDraftAnswer(a));
  }
}

function normalizeSql(raw) {
  if (!raw.length) return { columns: [], rows: [] };
  const columns = raw[0].columns;
  return {
    columns,
    rows: raw[0].values.map((row) => {
      const obj = {};
      columns.forEach((col, i) => {
        obj[col] = row[i];
      });
      return obj;
    })
  };
}

function tableHtml(result) {
  if (!result.columns.length) return "<div class='muted'>No rows returned.</div>";
  return `
    <table>
      <thead><tr>${result.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
      <tbody>${result.rows.map((row) => `<tr>${result.columns.map((c) => `<td>${esc(row[c])}</td>`).join("")}</tr>`).join("")}</tbody>
    </table>
  `;
}

function validateSql(a, result) {
  const validation = a.config.validation || a.validation || {};
  const expected = validation.expectedRows || [];
  if (!expected.length) return true;
  return JSON.stringify(result.rows) === JSON.stringify(expected);
}

async function loadPyodideRuntime() {
  if (window.loadPyodide) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/pyodide/v0.29.4/full/pyodide.js";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Unable to load Python runtime."));
    document.body.appendChild(script);
  });
}

async function pythonEngine() {
  if (PYODIDE) return PYODIDE;
  if (!pyodidePromise) {
    state.pythonPreload = "loading";
    renderPythonStatus();
    pyodidePromise = (async () => {
      await loadPyodideRuntime();
      PYODIDE = await loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.29.4/full/" });
      state.pythonPreload = "ready";
      renderPythonStatus();
      return PYODIDE;
    })().catch((error) => {
      state.pythonPreload = "error";
      pyodidePromise = null;
      renderPythonStatus();
      throw error;
    });
  }
  return pyodidePromise;
}

function hasPythonActivities() {
  return Boolean(state.data?.activities?.some((a) => isActive(a) && ["python_practice", "python_task"].includes(a.activityType)));
}

function warmPythonRuntime() {
  if (!hasPythonActivities() || state.pythonPreload !== "idle") return;
  pythonEngine().catch(() => {});
}

function renderPythonStatus() {
  const el = $("pythonStatus");
  if (!el) return;
  if (!hasPythonActivities()) {
    el.textContent = "";
    el.className = "runtime-status hidden";
    return;
  }
  el.classList.remove("hidden");
  const labels = {
    idle: "Python idle",
    loading: "Python loading",
    ready: "Python ready",
    error: "Python unavailable"
  };
  el.textContent = labels[state.pythonPreload] || "";
  el.className = `runtime-status ${state.pythonPreload}`;
}

async function runPython(id) {
  const a = findActivity(id);
  const error = $(`python_error_${id}`);
  const result = $(`python_result_${id}`);
  const code = $(`python_${id}`).value;
  error.innerHTML = "";
  result.innerHTML = state.pythonPreload === "ready" ? "<div class='muted'>Running code...</div>" : "<div class='muted'>Loading Python runtime...</div>";
  try {
    const py = await pythonEngine();
    py.globals.set("__training_user_code__", code);
    let output = py.runPython("import io, contextlib\n__training_capture__ = io.StringIO()\nwith contextlib.redirect_stdout(__training_capture__), contextlib.redirect_stderr(__training_capture__):\n    exec(__training_user_code__, {})\n__training_capture__.getvalue()");
    output = String(output || "");
    result.innerHTML = output ? `<pre class="python-output">${esc(output)}</pre>` : "<div class='muted'>Code executed with no printed output.</div>";
    const validation = a.config.validation || a.validation || {};
    const expected = String(validation.expectedOutput || "").replace(/\r\n/g, "\n").trim();
    const passed = !expected || output.replace(/\r\n/g, "\n").trim() === expected;
    state.pythonRuntime[id] = { code, output, interpreterStatus: "success", interpreterOutput: "", validationStatus: passed ? "passed" : "failed" };
    if (a.activityType === "python_practice") {
      await api("/api/learning-event", "POST", {
        courseId: a.courseId,
        activityId: a.activityId,
        activityType: a.activityType,
        eventType: "run_python",
        answer: { code, output },
        isCorrect: passed
      }).catch(() => {});
    }
  } catch (e) {
    result.innerHTML = "";
    error.innerHTML = `<div class="result error">Interpreter error: ${esc(e.message || e)}</div>`;
    state.pythonRuntime[id] = { code, output: "", interpreterStatus: "error", interpreterOutput: e.message || String(e), validationStatus: "not_checked" };
  }
}

async function startTimedAssessment(moduleId) {
  try {
    await api("/api/assessment/start-attempt", "POST", { moduleId });
    await load();
  } catch (e) {
    showResult("assessment_result", e.message, "error");
  }
}

function beginCountdown(moduleId, expiresAt) {
  stopCountdown();
  const tick = () => {
    const el = $("assessment_timer");
    if (!el) return;
    const left = new Date(expiresAt).getTime() - Date.now();
    if (left <= 0) {
      el.textContent = "00:00";
      stopCountdown();
      if (!state.timedSubmitStarted) {
        state.timedSubmitStarted = true;
        submitAssessment(moduleId, true);
      }
      return;
    }
    const totalSeconds = Math.ceil(left / 1000);
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    el.textContent = `${minutes}:${seconds}`;
  };
  tick();
  state.countdownId = setInterval(tick, 1000);
}

function stopCountdown() {
  if (state.countdownId) clearInterval(state.countdownId);
  state.countdownId = null;
}

async function submitAssessment(moduleId, autoExpired) {
  const tasks = activities(moduleId).filter((a) => a.activityType !== "assessment_block");
  const results = [];
  let error = "";

  tasks.forEach((a) => {
    if (error && !autoExpired) return;
    if (a.activityType === "quiz") {
      let correct = 0;
      (a.config.questions || []).forEach((q, i) => {
        const selected = [...document.querySelectorAll(`[name="q_${css(a.activityId)}_${i}"]:checked`)].map((n) => Number(n.value)).sort();
        if (JSON.stringify(selected) === JSON.stringify((q.correctAnswers || []).slice().sort())) correct += 1;
      });
      const total = (a.config.questions || []).length;
      results.push({
        activityId: a.activityId,
        answer: { correct },
        validationStatus: correct === total ? "passed" : "failed",
        score: total ? Math.round(Number(a.points || 0) * correct / total) : 0
      });
    } else if (a.activityType === "sql_task") {
      const runtime = state.sqlRuntime[a.activityId];
      if (!runtime) {
        if (autoExpired) results.push({ activityId: a.activityId, answer: {}, validationStatus: "not_checked", score: 0 });
        else error = "Run SQL before submitting.";
        return;
      }
      results.push({
        activityId: a.activityId,
        answer: { query: runtime.query, rows: runtime.normalized.rows },
        interpreterStatus: runtime.interpreterStatus,
        interpreterOutput: runtime.interpreterOutput,
        validationStatus: runtime.validationStatus,
        score: runtime.validationStatus === "passed" ? Number(a.points || 0) : 0
      });
    } else if (a.activityType === "python_task") {
      const runtime = state.pythonRuntime[a.activityId];
      if (!runtime) {
        if (autoExpired) results.push({ activityId: a.activityId, answer: {}, validationStatus: "not_checked", score: 0 });
        else error = "Run Python before submitting.";
        return;
      }
      results.push({
        activityId: a.activityId,
        answer: { code: runtime.code, output: runtime.output },
        interpreterStatus: runtime.interpreterStatus,
        interpreterOutput: runtime.interpreterOutput,
        validationStatus: runtime.validationStatus,
        score: runtime.validationStatus === "passed" ? Number(a.points || 0) : 0
      });
    } else if (a.activityType === "open_answer") {
      const text = $(`open_${a.activityId}`)?.value.trim() || "";
      const min = Number(a.config.minLength || 0);
      if (text.length < min && !autoExpired) {
        error = `Open answer must contain at least ${min} characters.`;
        return;
      }
      results.push({ activityId: a.activityId, answer: { text }, validationStatus: text.length >= min ? "pending_review" : "not_checked", score: 0 });
    }
  });

  if (error) {
    showResult("assessment_result", error, "warn");
    return;
  }

  try {
    stopCountdown();
    const response = await api("/api/assessment/submit-module", "POST", {
      moduleId,
      taskResults: results,
      submissionReason: autoExpired ? "time_expired" : "manual"
    });
    showResult("assessment_result", `${autoExpired ? "Time is over. " : ""}Submitted. Attempt ${response.attemptNo} / ${response.effectiveMaxAttempts}. Status: ${response.resultStatus}.`, "ok");
    if (state.authToken) await api("/api/draft/clear-module", "POST", { moduleId }).catch(() => {});
    state.timedSubmitStarted = false;
    await load();
  } catch (e) {
    state.timedSubmitStarted = false;
    showResult("assessment_result", e.message, "error");
  }
}

function showResult(id, message, type) {
  const el = $(id);
  if (el) el.innerHTML = `<div class="result ${type}">${esc(message)}</div>`;
}

function modal(html) {
  let dialog = $("editorModal");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "editorModal";
    document.body.appendChild(dialog);
  }
  dialog.innerHTML = html;
  dialog.showModal();
}

function closeModal() {
  disposeRichTextEditors();
  $("editorModal")?.close();
}

function val(id) {
  return $(id)?.value || "";
}

function checked(id) {
  return Boolean($(id)?.checked);
}

function textField(id, label, value = "") {
  return `<div class="field"><label>${esc(label)}</label><input id="${id}" value="${esc(value)}"></div>`;
}

function numberField(id, label, value = 0) {
  return `<div class="field"><label>${esc(label)}</label><input id="${id}" type="number" value="${esc(value)}"></div>`;
}

function textArea(id, label, value = "", code = false) {
  return `<div class="field"><label>${esc(label)}</label><textarea id="${id}" class="${code ? "code-area" : ""}">${esc(value)}</textarea></div>`;
}

function richTextEditor(id, label) {
  return `
    <div class="field">
      <label>${esc(label)}</label>
      <div id="${esc(id)}" class="text-editor"></div>
    </div>
  `;
}

function initRichTextEditor(id, html) {
  const editor = $(id);
  if (!editor) return;
  const initialHtml = sanitizeRichHtml(html || "<h2>Title</h2><p>Text</p>");
  if (typeof Quill === "undefined") {
    editor.innerHTML = `<textarea id="${esc(id)}_fallback" class="rich-editor-fallback">${esc(initialHtml)}</textarea>`;
    return;
  }
  const quill = new Quill(editor, {
    theme: "snow",
    placeholder: "Start typing...",
    modules: {
      toolbar: [
        [{ header: [1, 2, 3, false] }],
        ["bold", "italic", "underline", "strike"],
        [{ list: "ordered" }, { list: "bullet" }],
        ["blockquote", "link"],
        ["clean"]
      ]
    },
    formats: [
      "header",
      "bold",
      "italic",
      "underline",
      "strike",
      "list",
      "blockquote",
      "link"
    ]
  });
  quill.clipboard.dangerouslyPasteHTML(initialHtml);
  state.richTextEditors[id] = quill;
}

function richTextValue(id) {
  const quill = state.richTextEditors[id];
  if (quill) {
    return sanitizeRichHtml(quill.root.innerHTML || "");
  }
  return sanitizeRichHtml($(`${id}_fallback`)?.value || $(id)?.innerHTML || "");
}

function disposeRichTextEditors() {
  Object.keys(state.richTextEditors).forEach((id) => {
    if (!document.getElementById(id)) delete state.richTextEditors[id];
  });
}

function selectField(id, label, options, selected) {
  return `<div class="field"><label>${esc(label)}</label><select id="${id}">${options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(selected) ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select></div>`;
}

function modalHeader(title) {
  return `<div class="modal-head"><h3>${esc(title)}</h3><button class="x" onclick="closeModal()">X</button></div>`;
}

function openCourseEditor(courseId = "") {
  const course = courseId ? state.data.courses.find((c) => c.courseId === courseId) : {};
  modal(`
    ${modalHeader(courseId ? "Edit course" : "Add course")}
    <div class="grid-2">
      ${textField("ce_title", "Title", course.title || "")}
      ${textField("ce_category", "Category", course.category || "")}
    </div>
    ${textArea("ce_description", "Description", course.description || "")}
    <div class="grid-2">
      ${textField("ce_level", "Level", course.level || "Beginner")}
      ${numberField("ce_score", "Passing score", course.passingScore || 0)}
    </div>
    <button class="btn" onclick="saveCourse('${esc(courseId)}')">Save</button>
    <div id="modalMsg"></div>
  `);
}

async function saveCourse(courseId = "") {
  try {
    await api(courseId ? "/api/course/update" : "/api/course/create", "POST", {
      token: state.adminToken,
      courseId,
      title: val("ce_title"),
      description: val("ce_description"),
      category: val("ce_category"),
      level: val("ce_level") || "Beginner",
      passingScore: Number(val("ce_score") || 0),
      status: "active"
    });
    closeModal();
    await load();
  } catch (e) {
    showResult("modalMsg", e.message, "error");
  }
}

async function deleteCourse(courseId) {
  const course = state.data.courses.find((c) => c.courseId === courseId);
  if (!confirm(`Delete course "${course?.title || courseId}"? Its modules and activities will also be hidden.`)) return;
  await api("/api/course/delete", "POST", { token: state.adminToken, courseId });
  state.selectedCourse = "";
  state.selectedModule = "";
  await load();
}

function openModuleEditor(moduleId = "") {
  const module = moduleId ? state.data.modules.find((m) => m.moduleId === moduleId) : { courseId: state.selectedCourse, moduleType: "learning" };
  const courseOptions = state.data.courses.filter(isActive).sort(byOrder).map((c) => ({ value: c.courseId, label: c.title }));
  modal(`
    ${modalHeader(moduleId ? "Edit module" : "Add module")}
    <div class="grid-2">
      ${selectField("me_course", "Course", courseOptions, module.courseId)}
      ${selectField("me_type", "Module type", [{ value: "learning", label: "Learning" }, { value: "assessment", label: "Assessment" }], module.moduleType || "learning")}
    </div>
    ${textField("me_title", "Title", module.title || "")}
    ${textArea("me_description", "Description", module.description || "")}
    <div id="assessmentSettings"></div>
    <button class="btn" onclick="saveModule('${esc(moduleId)}')">Save</button>
    <div id="modalMsg"></div>
  `);
  $("me_type").onchange = () => renderAssessmentSettings(module);
  renderAssessmentSettings(module);
}

function renderAssessmentSettings(module = {}) {
  const box = $("assessmentSettings");
  if (!box) return;
  if (val("me_type") !== "assessment") {
    box.innerHTML = "";
    return;
  }
  const timed = truthy(module.isTimed);
  box.innerHTML = `
    <div class="editor-section">
      <div class="grid-3">
        ${numberField("me_attempts", "Max attempts", module.maxAttempts || 1)}
        ${numberField("me_passing", "Passing score", module.passingScore || 80)}
        ${selectField("me_review", "Review mode", [{ value: "mixed", label: "Mixed" }, { value: "auto", label: "Auto" }, { value: "manual", label: "Manual" }], module.reviewMode || "mixed")}
      </div>
      <label class="check-line"><input id="me_lock" type="checkbox" ${truthy(module.lockAfterSubmit ?? true) ? "checked" : ""}> Lock after submit</label>
      <label class="check-line"><input id="me_timed" type="checkbox" ${timed ? "checked" : ""}> Timed assessment</label>
      <div id="timeLimitField"></div>
    </div>
  `;
  $("me_timed").onchange = () => renderTimeLimit(module);
  renderTimeLimit(module);
}

function renderTimeLimit(module = {}) {
  const box = $("timeLimitField");
  if (box) box.innerHTML = checked("me_timed") ? numberField("me_time", "Time limit (minutes)", module.timeLimitMinutes || 30) : "";
}

async function saveModule(moduleId = "") {
  try {
    const isAssessment = val("me_type") === "assessment";
    await api(moduleId ? "/api/module/update" : "/api/module/create", "POST", {
      token: state.adminToken,
      moduleId,
      courseId: val("me_course"),
      moduleType: val("me_type"),
      title: val("me_title"),
      description: val("me_description"),
      maxAttempts: isAssessment ? Number(val("me_attempts") || 1) : "",
      passingScore: isAssessment ? Number(val("me_passing") || 0) : "",
      reviewMode: isAssessment ? val("me_review") : "",
      lockAfterSubmit: isAssessment ? checked("me_lock") : "",
      isTimed: isAssessment ? checked("me_timed") : "",
      timeLimitMinutes: isAssessment && checked("me_timed") ? Number(val("me_time") || 1) : "",
      status: "active"
    });
    closeModal();
    await load();
  } catch (e) {
    showResult("modalMsg", e.message, "error");
  }
}

async function deleteModule(moduleId) {
  const module = state.data.modules.find((m) => m.moduleId === moduleId);
  if (!confirm(`Delete module "${module?.title || moduleId}"? Its activities will also be hidden.`)) return;
  await api("/api/module/delete", "POST", { token: state.adminToken, moduleId });
  state.selectedModule = "";
  await load();
}

function openActivityEditor(moduleId, activityId = "", insertBefore = "", insertAfter = "") {
  const module = state.data.modules.find((m) => m.moduleId === moduleId);
  const activity = activityId ? findActivity(activityId) : null;
  const types = module.moduleType === "assessment"
    ? [["quiz", "Quiz"], ["sql_task", "SQL task"], ["python_task", "Python task"], ["open_answer", "Open answer"]]
    : [["html_content", "HTML content"], ["text", "Text"], ["image", "Image"], ["video", "Video player"], ["practice_quiz", "Practice quiz"], ["drag_mapping", "Drag mapping"], ["drag_order", "Drag order"], ["sql_practice", "SQL practice"], ["python_practice", "Python practice"]];
  modal(`
    ${modalHeader(activityId ? "Edit activity" : "Add activity")}
    <div class="grid-2">
      ${selectField("ae_type", "Activity type", types.map(([value, label]) => ({ value, label })), activity?.activityType || types[0][0])}
      ${textField("ae_title", "Admin title", activity?.title || "")}
    </div>
    <div id="activityFields"></div>
    <button class="btn" onclick="saveActivity('${esc(moduleId)}','${esc(activityId)}','${esc(insertBefore)}','${esc(insertAfter)}')">Save</button>
    <div id="modalMsg"></div>
  `);
  $("ae_type").onchange = () => renderActivityFields(activity);
  renderActivityFields(activity);
}

function renderActivityFields(activity) {
  const type = val("ae_type");
  const cfg = activity?.config || {};
  const validation = activity?.validation || {};
  const box = $("activityFields");
  if (!box) return;

  if (type === "html_content" || type === "content") {
    box.innerHTML = textArea("ae_content", "HTML content", activity?.content || "<div><h2>Title</h2><p>Text</p></div>", true);
  } else if (type === "text") {
    const initialHtml = cfg.html || `<h2>${esc(cfg.heading || "Title")}</h2><p>${esc(cfg.text || "Text").replace(/\n/g, "<br>")}</p>`;
    box.innerHTML = richTextEditor("ae_text_editor", "Text editor");
    initRichTextEditor("ae_text_editor", initialHtml);
  } else if (type === "image") {
    box.innerHTML = textField("ae_image", "Image URL", cfg.imageUrl || "") + textField("ae_caption", "Caption", cfg.caption || "");
  } else if (type === "video") {
    box.innerHTML = `
      <div class="grid-2">
        ${selectField("ae_video_source", "Source type", [{ value: "file", label: "Video file URL" }, { value: "embed", label: "Embed/page URL" }], cfg.sourceType || "file")}
        ${textField("ae_video", "Video URL", cfg.videoUrl || "")}
      </div>
      ${textField("ae_poster", "Poster image URL", cfg.posterUrl || "")}
      ${textField("ae_caption", "Caption", cfg.caption || "")}
      <div class="muted editor-hint">You can paste a YouTube, youtu.be, Shorts, Vimeo, embed URL, or a direct video file URL from your server.</div>
    `;
  } else if (type === "practice_quiz" || type === "quiz") {
    box.innerHTML = textArea("ae_intro", "Intro", cfg.intro || "") + `<div id="quizQuestions"></div><button class="btn ghost small" onclick="addQuestion()">+ Add question</button>`;
    (cfg.questions || [{ question: "", options: ["", ""], correctAnswers: [0] }]).forEach((q) => addQuestion(q));
  } else if (type === "drag_mapping") {
    box.innerHTML = `<div class="grid-2">${textField("ae_left_title", "Left title", cfg.leftTitle || "Targets")}${textField("ae_right_title", "Right title", cfg.rightTitle || "Values")}</div><div id="mappingPairs"></div><button class="btn ghost small" onclick="addPair()">+ Add pair</button>`;
    const mapping = cfg.correctMapping || {};
    const left = cfg.leftItems || Object.keys(mapping);
    (left.length ? left : [""]).forEach((item) => addPair(item, mapping[item] || ""));
  } else if (type === "drag_order") {
    box.innerHTML = textField("ae_question", "Question", cfg.question || "") + `<div id="orderSteps"></div><button class="btn ghost small" onclick="addStep()">+ Add step</button>`;
    (cfg.correctOrder || cfg.steps || [""]).forEach((step) => addStep(step));
  } else if (type === "sql_practice" || type === "sql_task") {
    const schemas = state.data.sqlSchemas.map((s) => ({ value: s.schemaId, label: s.title || s.schemaId }));
    box.innerHTML = selectField("ae_schema", "Schema", schemas, cfg.databaseSchemaId || schemas[0]?.value || "") +
      textArea("ae_instructions", "Instructions", cfg.instructions || activity?.content || "") +
      textArea("ae_query", "Starter SQL", cfg.defaultQuery || "", true) +
      textField("ae_columns", "Expected columns, comma-separated", (cfg.validation?.expectedColumns || validation.expectedColumns || []).join(", ")) +
      textArea("ae_rows", "Expected rows, JSON array", JSON.stringify(cfg.validation?.expectedRows || validation.expectedRows || [], null, 2), true);
  } else if (type === "python_practice" || type === "python_task") {
    box.innerHTML = textArea("ae_instructions", "Instructions", cfg.instructions || activity?.content || "") +
      textArea("ae_python_code", "Starter Python code", cfg.starterCode || "", true) +
      textArea("ae_python_output", "Expected printed output", cfg.validation?.expectedOutput || validation.expectedOutput || "");
  } else if (type === "open_answer") {
    box.innerHTML = textArea("ae_description", "Task description", activity?.content || "") +
      numberField("ae_min", "Minimum length", cfg.minLength || validation.minLength || 30) +
      textField("ae_placeholder", "Placeholder", cfg.placeholder || "Write your answer...");
  }

  if (["quiz", "sql_task", "python_task", "open_answer"].includes(type)) {
    box.innerHTML += `<div class="grid-2">${numberField("ae_points", "Points", activity?.points || 0)}<label class="check-line"><input id="ae_manual" type="checkbox" ${truthy(activity?.manualReviewRequired) ? "checked" : ""}> Manual review required</label></div>`;
  }
}

function addQuestion(question = { question: "", options: ["", ""], correctAnswers: [0] }) {
  const host = $("quizQuestions");
  const div = document.createElement("div");
  div.className = "editor-section question-editor";
  div.innerHTML = `
    <div class="repeat-row">
      <input class="q-text" placeholder="Question" value="${esc(question.question || "")}">
      <button class="btn danger small" onclick="this.closest('.question-editor').remove()">Remove</button>
    </div>
    <div class="answers"></div>
    <button class="btn ghost small" onclick="addAnswer(this)">+ Option</button>
  `;
  host.appendChild(div);
  (question.options || ["", ""]).forEach((option, i) => addAnswer(div.querySelector("button:last-child"), option, (question.correctAnswers || []).includes(i)));
}

function addAnswer(button, text = "", isCorrect = false) {
  const host = button.parentElement.querySelector(".answers");
  const row = document.createElement("div");
  row.className = "answer-row";
  row.innerHTML = `<input class="answer-text" placeholder="Answer option" value="${esc(text)}"><label><input class="answer-correct" type="checkbox" ${isCorrect ? "checked" : ""}> Correct</label><button class="btn danger small" onclick="this.parentElement.remove()">X</button>`;
  host.appendChild(row);
}

function addPair(left = "", right = "") {
  const row = document.createElement("div");
  row.className = "pair-row";
  row.innerHTML = `<input class="pair-left" placeholder="Left item" value="${esc(left)}"><input class="pair-right" placeholder="Matching value" value="${esc(right)}"><button class="btn danger small" onclick="this.parentElement.remove()">X</button>`;
  $("mappingPairs").appendChild(row);
}

function addStep(text = "") {
  const row = document.createElement("div");
  row.className = "repeat-row";
  row.innerHTML = `<input class="step-text" placeholder="Correct step" value="${esc(text)}"><button class="btn danger small" onclick="this.parentElement.remove()">X</button>`;
  $("orderSteps").appendChild(row);
}

async function saveActivity(moduleId, activityId = "", insertBefore = "", insertAfter = "") {
  try {
    const type = val("ae_type");
    const payload = {
      token: state.adminToken,
      activityId,
      moduleId,
      activityType: type,
      title: val("ae_title"),
      content: "",
      configJson: "{}",
      validationJson: "{}",
      points: Number(val("ae_points") || 0),
      manualReviewRequired: checked("ae_manual"),
      insertBeforeActivityId: insertBefore,
      insertAfterActivityId: insertAfter,
      status: "active"
    };
    let cfg = {};
    let validation = {};

    if (type === "html_content" || type === "content") payload.content = val("ae_content");
    else if (type === "text") cfg = { html: richTextValue("ae_text_editor") };
    else if (type === "image") cfg = { imageUrl: val("ae_image"), caption: val("ae_caption") };
    else if (type === "video") cfg = { sourceType: val("ae_video_source") || "file", videoUrl: val("ae_video"), posterUrl: val("ae_poster"), caption: val("ae_caption") };
    else if (type === "practice_quiz" || type === "quiz") {
      cfg = {
        intro: val("ae_intro"),
        questions: [...document.querySelectorAll(".question-editor")].map((q, i) => {
          const options = [...q.querySelectorAll(".answer-text")].map((input) => input.value);
          const correctAnswers = [...q.querySelectorAll(".answer-correct")].map((input, j) => input.checked ? j : null).filter((x) => x !== null);
          return { id: `q${i + 1}`, question: q.querySelector(".q-text").value, options, correctAnswers };
        })
      };
    } else if (type === "drag_mapping") {
      cfg = { leftTitle: val("ae_left_title"), rightTitle: val("ae_right_title"), leftItems: [], rightItems: [], correctMapping: {} };
      document.querySelectorAll(".pair-row").forEach((row) => {
        const left = row.querySelector(".pair-left").value;
        const right = row.querySelector(".pair-right").value;
        if (!left && !right) return;
        cfg.leftItems.push(left);
        cfg.rightItems.push(right);
        cfg.correctMapping[left] = right;
      });
    } else if (type === "drag_order") {
      cfg = { question: val("ae_question"), correctOrder: [...document.querySelectorAll(".step-text")].map((input) => input.value).filter(Boolean) };
      cfg.steps = cfg.correctOrder.slice();
    } else if (type === "sql_practice" || type === "sql_task") {
      validation = {
        expectedColumns: val("ae_columns").split(",").map((x) => x.trim()).filter(Boolean),
        expectedRows: parseJson(val("ae_rows"), [])
      };
      cfg = { databaseSchemaId: val("ae_schema"), instructions: val("ae_instructions"), defaultQuery: val("ae_query"), validation };
    } else if (type === "python_practice" || type === "python_task") {
      validation = { validationMode: "stdout_match", expectedOutput: val("ae_python_output") };
      cfg = { runtime: "pyodide", instructions: val("ae_instructions"), starterCode: val("ae_python_code"), validation };
    } else if (type === "open_answer") {
      payload.content = val("ae_description");
      cfg = { minLength: Number(val("ae_min") || 0), placeholder: val("ae_placeholder") };
      validation = { validationMode: "manual", minLength: cfg.minLength };
    }

    payload.configJson = JSON.stringify(cfg);
    payload.validationJson = JSON.stringify(validation);
    await api(activityId ? "/api/activity/update" : "/api/activity/create", "POST", payload);
    closeModal();
    await load();
  } catch (e) {
    showResult("modalMsg", e.message, "error");
  }
}

async function deleteActivity(activityId) {
  const activity = findActivity(activityId);
  if (!confirm(`Delete activity "${activity?.title || activityId}"?`)) return;
  await api("/api/activity/delete", "POST", { token: state.adminToken, activityId });
  await load();
}

function initAdminSorting() {
  if (!state.adminToken) return;
  initSortable("#courseList", ".course-sort-row", "courseId", "course");
  initSortable("#moduleList", ".module-sort-row", "moduleId", "module");
  initSortable("#activityList", ".activity-sort-row", "activityId", "activity");
}

function initSortable(containerSelector, rowSelector, key, type) {
  const container = document.querySelector(containerSelector);
  if (!container) return;
  container.querySelectorAll(rowSelector).forEach((row) => {
    const handle = row.querySelector(".sort-handle");
    if (!handle) return;
    handle.ondragstart = (event) => {
      state.dragItem = row;
      row.classList.add("dragging");
      if (event.dataTransfer) event.dataTransfer.setData("text/plain", row.dataset[key] || "");
    };
    handle.ondragend = async () => {
      row.classList.remove("dragging");
      const ids = [...container.querySelectorAll(rowSelector)].map((item) => item.dataset[key]);
      state.dragItem = null;
      await saveOrder(type, ids);
    };
  });
  container.ondragover = (event) => {
    if (!state.dragItem || !state.dragItem.matches(rowSelector)) return;
    event.preventDefault();
    const after = [...container.querySelectorAll(`${rowSelector}:not(.dragging)`)].find((row) => {
      const rect = row.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2;
    });
    if (after) container.insertBefore(state.dragItem, after);
    else container.appendChild(state.dragItem);
  };
}

async function saveOrder(type, orderedIds) {
  try {
    if (type === "course") {
      await api("/api/course/reorder", "POST", { token: state.adminToken, orderedIds });
      state.data.courses.forEach((course) => {
        const i = orderedIds.indexOf(course.courseId);
        if (i >= 0) course.displayOrder = i + 1;
      });
    } else if (type === "module") {
      await api("/api/module/reorder", "POST", { token: state.adminToken, courseId: state.selectedCourse, orderedIds });
      state.data.modules.forEach((module) => {
        const i = orderedIds.indexOf(module.moduleId);
        if (i >= 0) module.displayOrder = i + 1;
      });
    } else if (type === "activity") {
      await api("/api/activity/reorder", "POST", { token: state.adminToken, moduleId: state.selectedModule, orderedIds });
      state.data.activities.forEach((activity) => {
        const i = orderedIds.indexOf(activity.activityId);
        if (i >= 0) activity.displayOrder = i + 1;
      });
    }
  } catch (e) {
    alert(e.message);
    await load();
  }
}

function selectCourse(id) {
  state.selectedCourse = id;
  state.selectedModule = modules()[0]?.moduleId || "";
  saveNavigationState();
  render();
}

function selectModule(id) {
  state.selectedModule = id;
  saveNavigationState();
  render();
}

function setSignedIn(response) {
  state.authToken = response.token;
  state.authUser = response;
  state.adminToken = response.adminToken || "";
  state.adminUser = response.role === "admin" ? (response.displayName || response.email) : "";
  localStorage.setItem("authToken", response.token);
  localStorage.setItem("authUser", JSON.stringify(response));
  if (state.adminToken) {
    localStorage.setItem("adminToken", state.adminToken);
    localStorage.setItem("adminUser", state.adminUser);
  } else {
    localStorage.removeItem("adminToken");
    localStorage.removeItem("adminUser");
  }
}

function clearSignedIn() {
  state.authToken = "";
  state.authUser = null;
  state.adminToken = "";
  state.adminUser = "";
  localStorage.removeItem("authToken");
  localStorage.removeItem("authUser");
  localStorage.removeItem("adminToken");
  localStorage.removeItem("adminUser");
}

async function signOut() {
  await api("/api/auth/logout", "POST", {}).catch(() => {});
  clearSignedIn();
  state.data = null;
  $("courses").innerHTML = "";
  $("content").innerHTML = "";
  showAuthGate();
}

async function loginFromGate() {
  try {
    $("gateMsg").textContent = "";
    const endpoint = state.authMode === "register" ? "/api/auth/register" : "/api/auth/login";
    const response = await api(endpoint, "POST", { email: $("gateEmail").value, password: $("gatePass").value });
    setSignedIn(response);
    await load();
  } catch (e) {
    $("gateMsg").textContent = e.message;
  }
}

function renderAuthGateMode() {
  const isRegister = state.authMode === "register";
  $("gateLogin").textContent = isRegister ? "Создать аккаунт" : "Войти";
  $("gateMode").textContent = isRegister ? "Уже есть аккаунт? Войти" : "Создать аккаунт";
  $("gatePass").autocomplete = isRegister ? "new-password" : "current-password";
}

$("authBtn").onclick = () => signOut();
$("gateLogin").onclick = () => loginFromGate();
$("gateMode").onclick = () => {
  state.authMode = state.authMode === "register" ? "login" : "register";
  $("gateMsg").textContent = "";
  renderAuthGateMode();
};
$("gatePass").addEventListener("keydown", (event) => {
  if (event.key === "Enter") loginFromGate();
});
window.addEventListener("scroll", saveScrollPosition, { passive: true });

load().catch((e) => {
  clearSignedIn();
  showAuthGate(`Load error: ${e.message}`);
});
