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
  adminView: localStorage.getItem("adminView") || "builder",
  controlModule: localStorage.getItem("controlModule") || "",
  restoreScrollPending: true,
  scrollTimer: null,
  evidenceRefreshTimer: null
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
      const playlist = parsed.searchParams.get("list");
      if (playlist && (!videoId || videoId === "videoseries")) {
        const embed = new URL("https://www.youtube-nocookie.com/embed/videoseries");
        embed.searchParams.set("list", playlist);
        return embed.toString();
      }
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
  if (["experience_evidence", "worksheet"].includes(activity.activityType)) {
    const responses = {};
    (activity.config.prompts || []).forEach((prompt, i) => {
      responses[prompt.id || `p${i + 1}`] = $(`evidence_${activity.activityId}_${i}`)?.value || "";
    });
    return { type: activity.activityType, responses };
  }
  if (activity.activityType === "decision_table") {
    return { type: "decision_table", answers: decisionTableAnswer(activity.activityId, activity.config.rows || []) };
  }
  if (activity.activityType === "drag_mapping") {
    return { type: "drag_mapping", mapping: mappingAnswer(activity.activityId) };
  }
  if (activity.activityType === "rest_contract") {
    return { type: "rest_contract", contract: restContractAnswer(activity.activityId) };
  }
  if (activity.activityType === "impact_analysis") {
    return { type: "impact_analysis", selected: checkedValues(`impact_${activity.activityId}`) };
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
  if (isBuilderView()) initAdminSorting();
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
  if (state.adminToken && state.adminView === "control") {
    renderControlSidebar();
    return;
  }
  const courses = state.data.courses.filter(isActive).sort(byOrder);
  $("courses").innerHTML = `
    ${state.adminToken ? renderAdminTabs() : ""}
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
  if (state.adminToken && state.adminView === "control") {
    renderKnowledgeControl();
    return;
  }
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
    <section class="module-page ${module.courseId === "course_ba_card_replacement_onboarding" ? "onboarding-page" : ""}">
      <div class="module-header">
        <div>
          <span class="badge ${module.moduleType === "assessment" ? "black" : ""}">${tasks.some(a => a.activityType === "worksheet") ? "Практика с ментором" : module.moduleType === "assessment" ? "Assessment module" : "Learning module"}</span>
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
  activities(module.moduleId).filter(a => a.activityType === "worksheet").forEach(updateWorksheetProgress);
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
  const body = renderActivity(activity, assessment);
  const hidden = !state.adminToken && body.includes("data-evidence-hidden=\"true\"");
  return `
    <div class="activity-unit activity-sort-row" id="brick_${esc(activity.activityId)}" data-activity-id="${esc(activity.activityId)}" ${hidden ? "hidden" : ""}>
      ${state.adminToken ? `
        <div class="brick-admin">
          <button class="sort-handle activity-handle" title="Drag to reorder" draggable="true">::</button>
          <button class="btn ghost small" onclick="openActivityEditor('${esc(activity.moduleId)}','${esc(activity.activityId)}')">Edit</button>
          <button class="btn danger small" onclick="deleteActivity('${esc(activity.activityId)}')">Delete</button>
        </div>
      ` : ""}
      <div class="brick">
        <div class="brick-surface">${body}</div>
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
  if (a.activityType === "drag_mapping") return renderMapping(a, assessment);
  if (a.activityType === "drag_order") return renderOrder(a, assessment);
  if (a.activityType === "decision_table") return renderDecisionTable(a, assessment);
  if (a.activityType === "impact_analysis") return renderImpactAnalysis(a, assessment);
  if (a.activityType === "sql_practice" || a.activityType === "sql_task") return renderSql(a, assessment);
  if (a.activityType === "python_practice" || a.activityType === "python_task") return renderPython(a, assessment);
  if (a.activityType === "open_answer") return renderOpenAnswer(a, assessment);
  if (["experience_evidence", "worksheet"].includes(a.activityType)) return renderExperienceEvidence(a, assessment);
  if (a.activityType === "rest_contract") return renderRestContract(a, assessment);
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
      ${a.title ? `<h3>${esc(a.title)}</h3>` : ""}
      <div class="video-frame">${media}</div>
      ${caption ? `<figcaption>${esc(caption)}</figcaption>` : ""}
      ${shouldEmbed ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Открыть видео в отдельной вкладке</a>` : ""}
    </figure>
  `;
}

function quizOptionLabel(option) {
  if (typeof option === "object" && option !== null) {
    return option.label || option.text || option.value || "";
  }
  return option;
}

function quizOptionLevel(option) {
  if (typeof option !== "object" || option === null) return null;
  const level = Number(option.level ?? option.value);
  return Number.isFinite(level) ? level : null;
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
              <span>${esc(quizOptionLabel(opt))}</span>
            </label>
          `).join("")}
        </div>
      `).join("")}
      ${!assessment ? `<button class="btn" onclick="checkPractice('${esc(a.activityId)}')">Check answers</button><div id="result_${esc(a.activityId)}"></div>` : ""}
    </div>
  `;
}

function renderMapping(a, assessment) {
  const cfg = a.config || {};
  const rightItems = shuffle(cfg.rightItems || []);
  if (cfg.inputMode === "select") {
    return `<div class="task-card mapping-select">
      <h3>${esc(a.title || "Mapping")}</h3>
      ${cfg.scenario ? `<p class="muted">${esc(cfg.scenario)}</p>` : ""}
      ${(cfg.leftItems || []).map((target, i) => `<div class="field">
        <label for="mapping_${esc(a.activityId)}_${i}">${esc(target)}</label>
        <select id="mapping_${esc(a.activityId)}_${i}" data-mapping-target="${esc(target)}">
          <option value="">Выберите соответствие…</option>
          ${rightItems.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join("")}
        </select>
      </div>`).join("")}
      ${!assessment ? `<button class="btn" onclick="checkMapping('${esc(a.activityId)}')">Проверить</button><div id="result_${esc(a.activityId)}"></div>` : ""}
    </div>`;
  }
  return `
    <div class="task-card mapping-drag">
      <h3>${esc(a.title || "Сопоставление")}</h3>
      ${cfg.scenario ? `<p class="muted">${esc(cfg.scenario)}</p>` : ""}
      <div class="drag-grid">
        <div class="drag-box">
          <h3>${esc(cfg.rightTitle || "Values")}</h3>
          <div class="drop-zone pool">
            ${rightItems.map((v) => `<div class="drag-item" draggable="true" tabindex="0" role="button" aria-pressed="false" data-value="${esc(v)}"><span class="drag-grip" aria-hidden="true">⠿</span>${esc(v)}</div>`).join("")}
          </div>
        </div>
        <div class="drag-box">
          <h3>${esc(cfg.leftTitle || "Targets")}</h3>
          ${(cfg.leftItems || []).map((v) => `<div class="mapping-target"><b>${esc(v)}</b><div class="drop-zone mapping-zone" tabindex="0" role="button" aria-label="${esc(v)}" data-target="${esc(v)}"></div></div>`).join("")}
        </div>
      </div>
      ${!assessment ? `<button class="btn" onclick="checkMapping('${esc(a.activityId)}')">Check mapping</button><div id="result_${esc(a.activityId)}"></div>` : ""}
    </div>
  `;
}

function renderOrder(a, assessment) {
  const cfg = a.config || {};
  const steps = shuffle(cfg.steps || cfg.correctOrder || []);
  return `
    <div class="task-card">
      <h3>${esc(cfg.question || a.title || "Put steps in order")}</h3>
      <div class="muted">Порядок шагов — сверху вниз.</div>
      <div class="order-list" id="order_${esc(a.activityId)}">
        ${steps.map((s) => `
          <div class="drag-item order-item" draggable="true" tabindex="0" data-value="${esc(s)}">
            <span class="order-number"></span>
            <span>${esc(s)}</span>
          </div>`).join("")}
      </div>
      ${!assessment ? `<button class="btn" onclick="checkOrder('${esc(a.activityId)}')">Check order</button><div id="result_${esc(a.activityId)}"></div>` : ""}
    </div>
  `;
}

function renderDecisionTable(a, assessment) {
  const cfg = a.config || {};
  const rows = cfg.rows || [];
  const outcomes = cfg.outcomes || [];
  return `
    <div class="task-card decision-table">
      <h3>${esc(a.title || "Decision table")}</h3>
      ${cfg.scenario ? `<div class="muted">${esc(cfg.scenario)}</div>` : ""}
      <div class="sql-table-wrap">
        <table class="decision-grid">
          <thead>
            <tr>
              <th>Case</th>
              ${(cfg.conditions || []).map((condition) => `<th>${esc(condition)}</th>`).join("")}
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((row, i) => `
              <tr>
                <td>${esc(row.case || row.label || `Case ${i + 1}`)}</td>
                ${(row.conditions || []).map((value) => `<td>${esc(value)}</td>`).join("")}
                <td>
                  <select id="dt_${esc(a.activityId)}_${i}">
                    <option value="">Select...</option>
                    ${outcomes.map((outcome) => `<option value="${esc(outcome)}">${esc(outcome)}</option>`).join("")}
                  </select>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      ${!assessment ? `<button class="btn" onclick="checkDecisionTable('${esc(a.activityId)}')">Check table</button><div id="result_${esc(a.activityId)}"></div>` : ""}
    </div>
  `;
}

function renderImpactAnalysis(a, assessment) {
  const cfg = a.config || {};
  const areas = cfg.areas || [];
  const id = esc(a.activityId);
  return `
    <div class="task-card impact-analysis">
      <h3>${esc(a.title || "Impact analysis")}</h3>
      ${cfg.scenario ? `<div class="muted">${esc(cfg.scenario)}</div>` : ""}
      <div class="impact-grid">
        ${areas.map((area) => `
          <label class="option impact-option">
            <input type="checkbox" name="impact_${id}" value="${esc(area.id || area.label || area)}">
            <span>
              <b>${esc(area.label || area.id || area)}</b>
              ${area.description ? `<small>${esc(area.description)}</small>` : ""}
            </span>
          </label>
        `).join("")}
      </div>
      ${!assessment ? `<button class="btn" onclick="checkImpactAnalysis('${id}')">Check impacts</button><div id="result_${id}"></div>` : ""}
    </div>
  `;
}

function manualInputAttrs(assessment) {
  return assessment && !state.adminToken ? ` data-manual-input="true" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"` : "";
}

function manualInputHint(assessment) {
  return assessment && !state.adminToken ? `<div class="manual-input-hint">Paste and drag-and-drop are disabled for this assessment field.</div>` : "";
}

function renderSql(a, assessment) {
  return `
    <div class="task-card">
      <h3>${esc(a.title || "SQL task")}</h3>
      <div class="sql-task-brief">${esc(a.config.instructions || a.content || "")}</div>
      ${state.adminToken ? renderSqlExpected(a.config.validation || a.validation || {}) : ""}
      <div class="sql-controls">
        <button class="btn ghost small" id="db_btn_${esc(a.activityId)}" onclick="toggleTables('${esc(a.activityId)}','${esc(a.config.databaseSchemaId || "")}')">View demo tables</button>
      </div>
      <div id="db_${esc(a.activityId)}"></div>
      <div class="field"><label for="sql_${esc(a.activityId)}">Ваш SQL-запрос</label><textarea class="sql-editor" id="sql_${esc(a.activityId)}" placeholder="Введите SQL-запрос"${manualInputAttrs(assessment)}>${esc(a.config.defaultQuery || "")}</textarea></div>
      ${manualInputHint(assessment)}
      <button class="btn" onclick="runSql('${esc(a.activityId)}')">Run SQL</button>
      <div id="sql_error_${esc(a.activityId)}"></div>
      <div id="sql_result_${esc(a.activityId)}" class="sql-table-wrap"></div>
    </div>
  `;
}

function renderPython(a, assessment) {
  return `
    <div class="task-card">
      <h3>${esc(a.title || "Python task")}</h3>
      <div class="muted">${esc(a.config.instructions || a.content || "")}</div>
      <div class="field"><textarea class="python-editor" id="python_${esc(a.activityId)}"${manualInputAttrs(assessment)}>${esc(a.config.starterCode || "")}</textarea></div>
      ${manualInputHint(assessment)}
      <button class="btn" onclick="runPython('${esc(a.activityId)}')">Run Python</button>
      <div id="python_error_${esc(a.activityId)}"></div>
      <div id="python_result_${esc(a.activityId)}"></div>
    </div>
  `;
}

function renderOpenAnswer(a, assessment) {
  return `
    <div class="task-card">
      <h3>${esc(a.title || "Open answer")}</h3>
      <div class="muted">${esc(a.content || "")}</div>
      <div class="field">
        <textarea id="open_${esc(a.activityId)}" placeholder="${esc(a.config.placeholder || "Write your answer...")}"${manualInputAttrs(assessment)}></textarea>
      </div>
      ${manualInputHint(assessment)}
    </div>
  `;
}

function renderSqlExpected(validation) {
  const columns = validation.expectedColumns || [];
  const rows = validation.expectedRows || [];
  return `
    <div class="expected-answer">
      ${validation.expectedQuery ? `<b>Пример запроса для ментора</b><pre class="review-output">${esc(validation.expectedQuery)}</pre><p class="muted">Один из корректных вариантов. Автопроверка сравнивает результат, а не текст запроса.</p>` : ""}
      <b>Expected result</b>
      <div class="muted">Columns: ${esc(columns.join(", ") || "Not configured")}</div>
      ${rows.length ? tableHtml({ columns, rows }) : `<div class="muted">Rows are not configured.</div>`}
    </div>
  `;
}

function renderExperienceEvidence(a, assessment) {
  const worksheet = a.activityType === "worksheet";
  if (assessment && !state.adminToken) {
    const gate = evidenceGateStatus(a);
    if (!gate.unlocked) {
      return `<div data-evidence-activity="${esc(a.activityId)}" data-evidence-hidden="true"></div>`;
    }
  }
  const prompts = a.config.prompts || defaultEvidencePrompts();
  const min = Number(a.config.minLength || 60);
  return `
    <div class="task-card evidence-form ${worksheet ? "worksheet-form" : ""}" data-evidence-activity="${esc(a.activityId)}">
      <h3>${esc(a.title || "Experience evidence")}</h3>
      ${a.content || a.config.instructions ? `<div class="muted">${esc(a.content || a.config.instructions)}</div>` : ""}
      ${worksheet ? `<div class="worksheet-status" id="worksheet_status_${esc(a.activityId)}" aria-live="polite"></div>` : ""}
      ${prompts.map((prompt, i) => `
        <details class="field evidence-field" open>
          <summary>${esc(i + 1)}. ${esc(prompt.label || prompt.question || `Evidence ${i + 1}`)}</summary>
          ${prompt.hint ? `<div class="muted">${esc(prompt.hint)}</div>` : ""}
          <textarea aria-label="${esc(prompt.label || prompt.question || `Evidence ${i + 1}`)}" id="evidence_${esc(a.activityId)}_${i}" placeholder="${esc(prompt.placeholder || "Describe a concrete example, your role, artifacts, stakeholders, and result.")}"${manualInputAttrs(assessment && !a.config.allowPaste)}></textarea>
        </details>
      `).join("")}
      ${!worksheet ? `<div class="manual-input-hint">${assessment && !state.adminToken ? `Each field should be typed manually. Minimum recommended length: ${esc(min)} characters.` : "Reviewer uses this evidence to confirm senior levels."}</div>` : ""}
      ${worksheet && !state.adminToken ? `<div class="worksheet-actions"><button class="btn" onclick="saveWorksheet('${esc(a.activityId)}')">Сохранить ответы</button><span id="worksheet_saved_${esc(a.activityId)}" role="status"></span></div>` : ""}
    </div>
  `;
}

function defaultEvidencePrompts() {
  return [
    { id: "domain", label: "Relevant BA experience and domain", hint: "Mention domain, product/process area, team size, and your BA role." },
    { id: "complex_case", label: "Complex requirement or delivery case", hint: "Describe the problem, stakeholders, constraints, your actions, and measurable outcome." },
    { id: "artifacts", label: "Artifacts you personally produced", hint: "Examples: user stories, BPMN, decision tables, API contract, impact analysis, backlog refinement package." },
    { id: "mentorship", label: "Mentorship, ownership, or standards", hint: "For L4-L5: describe mentoring, review, standards, governance, or cross-team ownership." }
  ];
}

function evidenceGateStatus(activity) {
  const gate = activity.config.unlock || activity.config.gate || null;
  if (!gate || gate.enabled === false) return { unlocked: true, completed: true, percent: 100, requiredPercent: 0, earned: 0, max: 0 };
  const requiredPercent = Number(gate.minAutoScorePercent ?? gate.minPercent ?? 80);
  const score = automaticScoreBeforeActivity(activity);
  const completed = automaticTasksBeforeActivity(activity).every(isAutomaticTaskComplete);
  const percent = score.max ? Math.round(score.earned * 100 / score.max) : 0;
  return {
    unlocked: completed && score.max > 0 && percent >= requiredPercent,
    completed,
    percent,
    requiredPercent,
    earned: score.earned,
    max: score.max
  };
}

function automaticTasksBeforeActivity(activity) {
  const autoTypes = new Set(["quiz", "drag_mapping", "drag_order", "decision_table", "impact_analysis", "rest_contract", "sql_task", "python_task"]);
  return activities(activity.moduleId)
    .filter((item) => autoTypes.has(item.activityType) && Number(item.displayOrder || 0) < Number(activity.displayOrder || 0));
}

function automaticScoreBeforeActivity(activity) {
  const rows = automaticTasksBeforeActivity(activity);
  return rows.reduce((sum, item) => {
    const points = Number(item.points || 0);
    const ratio = automaticScoreRatio(item);
    sum.earned += Math.round(points * ratio);
    sum.max += points;
    return sum;
  }, { earned: 0, max: 0 });
}

function isAutomaticTaskComplete(activity) {
  if (activity.activityType === "quiz") {
    const questions = activity.config.questions || [];
    return questions.length > 0 && questions.every((q, i) => document.querySelectorAll(`[name="q_${css(activity.activityId)}_${i}"]:checked`).length > 0);
  }
  if (activity.activityType === "drag_mapping") {
    const expected = Object.keys(activity.config.correctMapping || {});
    const answer = mappingAnswer(activity.activityId);
    return expected.length > 0 && expected.every((key) => !!answer[key]);
  }
  if (activity.activityType === "drag_order") {
    return orderAnswer(activity.activityId).length === (activity.config.correctOrder || []).length;
  }
  if (activity.activityType === "decision_table") {
    const rows = activity.config.rows || [];
    const answer = decisionTableAnswer(activity.activityId, rows);
    return rows.length > 0 && rows.every((row, i) => !!answer[row.id || `r${i + 1}`]);
  }
  if (activity.activityType === "impact_analysis") {
    return checkedValues(`impact_${activity.activityId}`).length > 0;
  }
  if (activity.activityType === "rest_contract") {
    const answer = restContractAnswer(activity.activityId);
    return !!answer.method && !!answer.path && !!answer.requestBody && !!answer.successStatus;
  }
  if (activity.activityType === "sql_task") return !!state.sqlRuntime[activity.activityId];
  if (activity.activityType === "python_task") return !!state.pythonRuntime[activity.activityId];
  return false;
}

function automaticScoreRatio(activity) {
  if (activity.activityType === "quiz") {
    const questions = activity.config.questions || [];
    const correct = questions.filter((q, i) => {
      const selected = [...document.querySelectorAll(`[name="q_${css(activity.activityId)}_${i}"]:checked`)].map((n) => Number(n.value)).sort();
      return JSON.stringify(selected) === JSON.stringify((q.correctAnswers || []).slice().sort());
    }).length;
    return questions.length ? correct / questions.length : 0;
  }
  if (activity.activityType === "drag_mapping") return evaluateMapping(activity).scoreRatio;
  if (activity.activityType === "drag_order") return evaluateOrder(activity).scoreRatio;
  if (activity.activityType === "decision_table") return evaluateDecisionTable(activity).scoreRatio;
  if (activity.activityType === "impact_analysis") return evaluateImpactAnalysis(activity).scoreRatio;
  if (activity.activityType === "rest_contract") return evaluateRestContract(activity).scoreRatio;
  if (activity.activityType === "sql_task") return state.sqlRuntime[activity.activityId]?.validationStatus === "passed" ? 1 : 0;
  if (activity.activityType === "python_task") return state.pythonRuntime[activity.activityId]?.validationStatus === "passed" ? 1 : 0;
  return 0;
}

function refreshConditionalEvidence(force = false) {
  if (state.adminToken) return;
  activities(state.selectedModule).filter((activity) => ["experience_evidence", "worksheet"].includes(activity.activityType)).forEach((activity) => {
    const brick = document.querySelector(`#brick_${css(activity.activityId)}`);
    const surface = brick?.querySelector(".brick-surface");
    if (!surface) return;
    const currentlyHidden = !!surface.querySelector("[data-evidence-hidden='true']");
    const gate = evidenceGateStatus(activity);
    if (force || currentlyHidden || !gate.unlocked) {
      const html = renderExperienceEvidence(activity, true);
      surface.innerHTML = html;
      brick.hidden = html.includes("data-evidence-hidden=\"true\"");
      initManualInputOnly();
      initDraftListeners();
      applyDrafts(activity.moduleId);
    }
  });
}

function scheduleEvidenceRefresh() {
  clearTimeout(state.evidenceRefreshTimer);
  state.evidenceRefreshTimer = setTimeout(() => refreshConditionalEvidence(false), 120);
}

function renderRestContract(a, assessment) {
  const cfg = a.config || {};
  const validation = a.validation || cfg.validation || {};
  const methods = cfg.methodOptions || ["GET", "POST", "PUT", "PATCH", "DELETE"];
  const paths = cfg.pathOptions || [validation.path || "/api/resource"];
  const pathParams = cfg.pathParamOptions || validation.pathParams || [];
  const queryParams = cfg.queryParamOptions || validation.queryParams || [];
  const requestBodies = cfg.requestBodyOptions || ["none", "json"];
  const successStatuses = cfg.successStatusOptions || [200, 201, 204];
  const errorStatuses = cfg.errorStatusOptions || [400, 401, 403, 404, 409, 422, 500];
  const responseFields = cfg.responseFieldOptions || validation.responseFields || [];
  const id = esc(a.activityId);
  return `
    <div class="task-card rest-contract">
      <h3>${esc(a.title || "REST Contract Builder")}</h3>
      ${cfg.scenario ? `<div class="muted">${esc(cfg.scenario)}</div>` : ""}
      <div class="grid-2">
        <div class="field">
          <label>HTTP method</label>
          <select id="rest_method_${id}">${methods.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("")}</select>
        </div>
        <div class="field">
          <label>Endpoint path</label>
          <select id="rest_path_${id}">${paths.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("")}</select>
        </div>
      </div>
      <div class="grid-2">
        ${restChecklist(id, "path_params", "Path parameters", pathParams, (item) => item)}
        ${restChecklist(id, "query_params", "Query parameters", queryParams, queryLabel)}
      </div>
      <div class="grid-2">
        <div class="field">
          <label>Request body</label>
          <select id="rest_body_${id}">${requestBodies.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join("")}</select>
        </div>
        <div class="field">
          <label>Success status</label>
          <select id="rest_success_${id}">${successStatuses.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}</select>
        </div>
      </div>
      <div class="grid-2">
        ${restChecklist(id, "error_statuses", "Error statuses", errorStatuses, (item) => item)}
        ${restChecklist(id, "response_fields", "Response fields", responseFields, (item) => item)}
      </div>
      ${state.adminToken ? renderRestExpected(validation) : ""}
      ${!assessment ? `<button class="btn" onclick="checkRestContract('${id}')">Check contract</button><div id="result_${id}"></div>` : ""}
    </div>
  `;
}

function renderRestExpected(validation) {
  return `
    <div class="expected-answer">
      <b>Expected REST contract</b>
      <div class="grid-2">
        <div><span class="muted">Method</span><br>${esc(validation.method || "")}</div>
        <div><span class="muted">Path</span><br>${esc(validation.path || "")}</div>
        <div><span class="muted">Path params</span><br>${esc((validation.pathParams || []).join(", ") || "None")}</div>
        <div><span class="muted">Query params</span><br>${esc(normalizeQueryParams(validation.queryParams || []).join(", ") || "None")}</div>
        <div><span class="muted">Request body</span><br>${esc(validation.requestBody || "none")}</div>
        <div><span class="muted">Success status</span><br>${esc(validation.successStatus || "")}</div>
        <div><span class="muted">Error statuses</span><br>${esc((validation.errorStatuses || []).join(", ") || "None")}</div>
        <div><span class="muted">Response fields</span><br>${esc((validation.responseFields || []).join(", ") || "None")}</div>
      </div>
    </div>
  `;
}

function restChecklist(activityId, group, label, items, labeler) {
  return `
    <div class="rest-choice-group">
      <b>${esc(label)}</b>
      ${(items || []).map((item, i) => {
        const value = restOptionValue(item);
        return `
          <label class="option">
            <input type="checkbox" name="rest_${group}_${activityId}" value="${esc(value)}">
            <span>${esc(labeler(item, i))}</span>
          </label>
        `;
      }).join("") || `<div class="muted">No options configured.</div>`}
    </div>
  `;
}

function queryLabel(item) {
  if (typeof item === "string") return item;
  return `${item.name || ""}${item.value !== undefined && item.value !== "" ? `=${item.value}` : ""}`;
}

function restOptionValue(item) {
  if (typeof item === "object" && item !== null) return queryLabel(item);
  return String(item ?? "");
}

function renderAssessmentModule(module, tasks) {
  const progress = getProgress(module.moduleId);
  const timed = truthy(module.isTimed);
  const placement = module.reviewMode === "placement";
  const leveling = module.reviewMode === "leveling";
  const worksheet = tasks.some(a => a.activityType === "worksheet");
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
        ${worksheet ? "" : `<h3>${esc(module.title)}</h3>`}
        <div class="muted">${worksheet ? "" : placement
          ? "Choose the option that best matches the respondent's current behavior. The system will recommend a level automatically."
          : leveling
            ? "Complete the skill checks. The system will calculate the highest confirmed level and show which level is not yet confirmed."
          : `One submit consumes one attempt. Passing score: ${esc(module.passingScore || 0)}%.`}</div>
        <div class="badge grey">${worksheet ? "Отправлено" : "Attempts"}: ${esc(attemptsText)}</div>
        ${placement ? `<div class="badge grey">Placement assessment</div>` : ""}
        ${leveling ? `<div class="badge grey">Level assessment</div>` : ""}
        ${timed && activeAttempt && !state.adminToken ? `<div class="assessment-timer"><span>Time remaining</span><span class="timer-value" id="assessment_timer">--:--</span></div>` : ""}
        ${timed && state.adminToken ? `<div class="badge grey">Timed: ${esc(module.timeLimitMinutes || 1)} min (admin preview)</div>` : ""}
      </div>
      ${renderActivityList(module, visibleTasks, true)}
      ${!state.adminToken ? `<button class="btn" ${canSubmit ? "" : "disabled"} onclick="submitAssessment('${esc(module.moduleId)}', false)">${worksheet ? "Отправить ментору" : placement ? "Submit placement assessment" : leveling ? "Submit level assessment" : "Submit assessment module"}</button><div id="assessment_result"></div>` : ""}
    </div>
  `;

  if (timed && activeAttempt && !state.adminToken) {
    setTimeout(() => beginCountdown(module.moduleId, activeAttempt.expiresAt), 0);
  } else {
    stopCountdown();
  }
  return assessmentHtml;
}

function renderAdminTabs() {
  return `
    <div class="admin-tabs">
      <button class="${state.adminView === "builder" ? "active" : ""}" onclick="setAdminView('builder')">Конструктор</button>
      <button class="${state.adminView === "control" ? "active" : ""}" onclick="setAdminView('control')">Контроль знаний</button>
    </div>
  `;
}

function setAdminView(view) {
  state.adminView = view === "control" ? "control" : "builder";
  localStorage.setItem("adminView", state.adminView);
  render();
}

function isBuilderView() {
  return !state.adminToken || state.adminView === "builder";
}

function assessmentModules() {
  return state.data.modules.filter((m) => m.moduleType === "assessment" && isActive(m)).sort(byOrder);
}

function renderControlSidebar() {
  const assessments = assessmentModules();
  const levelAssessments = assessments.filter((m) => m.reviewMode === "leveling");
  const regularAssessments = assessments.filter((m) => m.reviewMode !== "leveling");
  const moduleButton = (m) => {
    const course = state.data.courses.find((c) => c.courseId === m.courseId);
    return `
      <button class="nav-card ${state.controlModule === m.moduleId ? "active" : ""}" onclick="selectControlModule('${esc(m.moduleId)}')">
        <b>${esc(m.title)}</b>
        <span>${esc(course?.title || m.courseId)}</span>
      </button>
    `;
  };
  $("courses").innerHTML = `
    ${renderAdminTabs()}
    <div class="side-head">Assessment modules</div>
    <div class="nav-list">
      <button class="nav-card ${state.controlModule === "" ? "active" : ""}" onclick="selectControlModule('')">
        <b>Все модули</b>
        <span>Общая аналитика и контроль</span>
      </button>
    </div>
    ${levelAssessments.length ? `<div class="side-head">Level assessments</div><div class="nav-list">${levelAssessments.map(moduleButton).join("")}</div>` : ""}
    ${regularAssessments.length ? `<div class="side-head">Regular assessments</div><div class="nav-list">${regularAssessments.map(moduleButton).join("")}</div>` : ""}
  `;
}

function selectControlModule(moduleId) {
  state.controlModule = moduleId;
  localStorage.setItem("controlModule", moduleId);
  render();
}

function renderKnowledgeControl() {
  const module = state.controlModule ? state.data.modules.find((m) => m.moduleId === state.controlModule) : null;
  $("content").innerHTML = `
    <section class="module-page control-page">
      <div class="module-header">
        <div>
          <span class="badge black">Контроль знаний</span>
          <h2>${module ? esc(module.title) : "Все assessment-попытки"}</h2>
          <div class="muted">Просмотр прохождений, ручная проверка открытых ответов и статусы студентов.</div>
        </div>
        <button class="btn ghost small" onclick="loadAssessmentAttempts('${esc(state.controlModule)}','knowledge_attempts')">Refresh</button>
      </div>
      <div id="knowledge_summary" class="metric-grid"></div>
      <div id="knowledge_attempts" class="review-list">
        <div class="muted">Loading submissions...</div>
      </div>
    </section>
  `;
  setTimeout(() => loadAssessmentAttempts(state.controlModule, "knowledge_attempts"), 0);
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
  initManualInputOnly();
  initEvidenceRefreshInputs();
  initInterview();
  refreshOrderNumbers();
}

function updateWorksheetProgress(activity) {
  const box = $(`worksheet_status_${activity.activityId}`);
  if (!box) return;
  const prompts = activity.config.prompts || [];
  const count = prompts.filter((prompt, i) => $(`evidence_${activity.activityId}_${i}`)?.value.trim()).length;
  box.textContent = `Заполнено ${count} из ${prompts.length}`;
}

async function saveWorksheet(id) {
  const activity = findActivity(id);
  const status = $(`worksheet_saved_${id}`);
  if (!activity || !status) return;
  clearTimeout(state.draftTimers[id]);
  const answer = collectDraftAnswer(activity);
  setDraftLocal(activity.moduleId, id, answer);
  status.textContent = "Сохраняем…";
  try {
    await api("/api/draft/save", "POST", { moduleId: activity.moduleId, activityId: id, answer });
    status.textContent = "Ответы сохранены";
  } catch (error) {
    status.textContent = `Не удалось сохранить: ${error.message}`;
  }
}

function initInterview() {
  document.querySelectorAll("[data-interview]").forEach(interview => {
    interview.querySelectorAll("[data-interview-topic]").forEach(link => {
      link.onclick = event => {
        const target = $(link.dataset.interviewTopic);
        if (!target) return;
        event.preventDefault();
        target.open = true;
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      };
    });
    interview.querySelectorAll("[data-interview-expand]").forEach(button => {
      button.onclick = () => interview.querySelectorAll(".interview-topic").forEach(topic => {
        topic.open = button.dataset.interviewExpand === "true";
      });
    });
    interview.querySelectorAll("[data-quote-author]").forEach(button => {
      button.onclick = () => {
        const worksheet = activities(state.selectedModule).find(a => a.activityType === "worksheet");
        const field = worksheet && $(`evidence_${worksheet.activityId}_0`);
        if (!field) return;
        const quote = button.closest(".interview-message").querySelector(".interview-message-text").textContent.trim();
        field.value = [field.value.trim(), `${button.dataset.quoteAuthor}: «${quote}»`].filter(Boolean).join("\n\n");
        field.closest("details").open = true;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        const feedback = interview.querySelector("[data-interview-feedback]");
        if (feedback) feedback.textContent = "Цитата добавлена в поле «Подтвержденные требования»";
      };
    });
  });
}

function initEvidenceRefreshInputs() {
  document.querySelectorAll("input[name^='rest_'], select[id^='rest_'], select[id^='dt_'], select[data-mapping-target], input[name^='impact_'], input[name^='q_']").forEach((input) => {
    input.addEventListener("change", scheduleEvidenceRefresh);
  });
}

function initManualInputOnly() {
  document.querySelectorAll("[data-manual-input='true']").forEach((input) => {
    const block = (event) => {
      event.preventDefault();
      showManualInputMessage(input);
    };
    input.onpaste = block;
    input.ondrop = block;
    input.oncontextmenu = block;
    input.onbeforeinput = (event) => {
      if (["insertFromPaste", "insertFromDrop", "insertFromYank"].includes(event.inputType)) block(event);
    };
  });
}

function showManualInputMessage(input) {
  const card = input.closest(".task-card");
  const hint = card?.querySelector(".manual-input-hint");
  if (!hint) return;
  hint.textContent = "Paste is disabled here. Please type the answer manually.";
  hint.classList.add("warn");
  clearTimeout(hint._timer);
  hint._timer = setTimeout(() => {
    hint.textContent = "Paste and drag-and-drop are disabled for this assessment field.";
    hint.classList.remove("warn");
  }, 2200);
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
    } else if (["experience_evidence", "worksheet"].includes(activity.activityType)) {
      (activity.config.prompts || defaultEvidencePrompts()).forEach((prompt, i) => {
        const input = $(`evidence_${activity.activityId}_${i}`);
        if (input) input.oninput = () => {
          saveDraft(activity.moduleId, activity.activityId, collectDraftAnswer(activity));
          updateWorksheetProgress(activity);
          const saved = $(`worksheet_saved_${activity.activityId}`);
          if (saved) saved.textContent = "Изменения сохраняются в черновик";
        };
      });
    } else if (activity.activityType === "decision_table") {
      (activity.config.rows || []).forEach((row, i) => {
        const input = $(`dt_${activity.activityId}_${i}`);
        if (input) input.onchange = () => saveDraft(activity.moduleId, activity.activityId, collectDraftAnswer(activity));
      });
    } else if (activity.activityType === "impact_analysis") {
      document.querySelectorAll(`[name="impact_${css(activity.activityId)}"]`).forEach((input) => {
        input.onchange = () => saveDraft(activity.moduleId, activity.activityId, collectDraftAnswer(activity));
      });
    } else if (["rest_contract", "drag_mapping"].includes(activity.activityType)) {
      document.querySelectorAll(`#brick_${css(activity.activityId)} select, #brick_${css(activity.activityId)} input[type='checkbox']`).forEach(input => {
        input.onchange = () => saveDraft(activity.moduleId, activity.activityId, collectDraftAnswer(activity));
      });
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
    } else if (["experience_evidence", "worksheet"].includes(activity.activityType)) {
      (activity.config.prompts || defaultEvidencePrompts()).forEach((prompt, i) => {
        const input = $(`evidence_${activity.activityId}_${i}`);
        const key = prompt.id || `p${i + 1}`;
        if (input) {
          const legacy = (prompt.legacyIds || []).filter(id => id !== key).map(id => draft.responses?.[id]).filter(Boolean);
          input.value = [draft.responses?.[key], ...legacy].filter(Boolean).join("\n\n");
        }
      });
    } else if (activity.activityType === "drag_order" && Array.isArray(draft.order)) {
      const list = $("order_" + activity.activityId);
      const items = list ? [...list.querySelectorAll('.order-item')] : [];
      draft.order.forEach(value => { const item = items.find(item => item.dataset.value === value); if (item) list.appendChild(item); });
      refreshOrderNumbers();
    } else if (activity.activityType === "decision_table") {
      (activity.config.rows || []).forEach((row, i) => {
        const input = $(`dt_${activity.activityId}_${i}`);
        const key = row.id || `r${i + 1}`;
        if (input && draft.answers?.[key]) input.value = draft.answers[key];
      });
    } else if (activity.activityType === "impact_analysis") {
      document.querySelectorAll(`[name="impact_${css(activity.activityId)}"]`).forEach((input) => {
        input.checked = (draft.selected || []).includes(input.value);
      });
    } else if (activity.activityType === "drag_mapping") {
      document.querySelectorAll(`#brick_${css(activity.activityId)} [data-mapping-target]`).forEach(input => {
        input.value = draft.mapping?.[input.dataset.mappingTarget] || "";
      });
      const brick = $("brick_" + activity.activityId);
      const pool = brick?.querySelector('.pool');
      if (pool) {
        brick.querySelectorAll('.mapping-zone .drag-item').forEach(item => pool.appendChild(item));
        brick.querySelectorAll('.mapping-zone').forEach(zone => {
          const item = [...pool.querySelectorAll('.drag-item')].find(item => item.dataset.value === draft.mapping?.[zone.dataset.target]);
          if (item) zone.appendChild(item);
        });
      }
    } else if (activity.activityType === "rest_contract" && draft.contract) {
      const answer = draft.contract;
      for (const [key, property] of [["method", "method"], ["path", "path"], ["body", "requestBody"], ["success", "successStatus"]]) {
        const input = $(`rest_${key}_${activity.activityId}`);
        if (input && answer[property] !== undefined) input.value = String(answer[property]);
      }
      for (const [group, property] of [["path_params", "pathParams"], ["query_params", "queryParams"], ["error_statuses", "errorStatuses"], ["response_fields", "responseFields"]]) {
        document.querySelectorAll(`[name="rest_${group}_${css(activity.activityId)}"]`).forEach(input => {
          input.checked = (answer[property] || []).map(String).includes(input.value);
        });
      }
    } else if (activity.activityType === "sql_task") {
      const input = $(`sql_${activity.activityId}`);
      if (input && draft.query) input.value = draft.query;
    }
  });
}

function initMappingDrag(container) {
  let selected = null;
  const place = (zone, item) => {
    if (!item || item.closest('.activity-unit') !== container) return;
    const existing = zone.classList.contains('mapping-zone') && zone.querySelector('.drag-item');
    if (existing && existing !== item) container.querySelector('.pool')?.appendChild(existing);
    zone.appendChild(item);
    item.classList.remove('is-selected');
    item.setAttribute('aria-pressed', 'false');
    selected = null;
    const activity = findActivity(container.dataset.activityId);
    if (activity) saveDraft(activity.moduleId, activity.activityId, collectDraftAnswer(activity));
    scheduleEvidenceRefresh();
  };
  container.querySelectorAll(".drag-item:not(.order-item)").forEach(el => {
    el.onclick = event => {
      event.stopPropagation();
      container.querySelectorAll('.is-selected').forEach(item => { item.classList.remove('is-selected'); item.setAttribute('aria-pressed','false'); });
      selected = selected === el ? null : el;
      el.classList.toggle('is-selected', selected === el);
      el.setAttribute('aria-pressed', String(selected === el));
    };
    el.onkeydown = event => { if (['Enter',' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); el.click(); } };
    el.ondragstart = event => { state.dragItem = el; el.classList.add('dragging'); event.dataTransfer?.setData('text/plain', el.dataset.value); };
    el.ondragend = () => { el.classList.remove('dragging'); container.querySelectorAll('.over').forEach(zone => zone.classList.remove('over')); state.dragItem = null; };
  });
  container.querySelectorAll('.drop-zone').forEach(zone => {
    zone.onclick = event => { if (event.target === zone) place(zone, selected); };
    zone.onkeydown = event => { if (event.target === zone && ['Enter',' '].includes(event.key)) { event.preventDefault(); place(zone, selected); } };
    zone.ondragover = event => { event.preventDefault(); zone.classList.add('over'); };
    zone.ondragleave = () => zone.classList.remove('over');
    zone.ondrop = event => { event.preventDefault(); zone.classList.remove('over'); place(zone, state.dragItem); };
  });
}

function initOrderDrag(list) {
  list.querySelectorAll(".order-item").forEach((item) => {
    item.onkeydown = event => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        moveOrderStep(item, event.key === 'ArrowUp' ? -1 : 1);
        item.focus();
      }
    };
    item.ondragstart = () => {
      state.dragItem = item;
      item.classList.add("dragging");
    };
    item.ondragend = () => {
      item.classList.remove("dragging");
      state.dragItem = null;
      refreshOrderNumbers();
      scheduleEvidenceRefresh();
      const id = list.id.slice('order_'.length);
      const activity = findActivity(id);
      if (activity) saveDraft(activity.moduleId, id, {type:'drag_order', order:orderAnswer(id)});
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

async function checkRestContract(id) {
  const a = findActivity(id);
  const result = evaluateRestContract(a);
  showResult(`result_${id}`, `Result: ${result.correct} / ${result.total}.`, result.passed ? "ok" : "warn");
  await api("/api/learning-event", "POST", {
    courseId: a.courseId,
    activityId: a.activityId,
    activityType: a.activityType,
    answer: result.answer,
    isCorrect: result.passed,
    feedback: `Result: ${result.correct} / ${result.total}`
  }).catch(() => {});
}

function evaluateMapping(a) {
  const expected = a.config.correctMapping || {};
  const answer = mappingAnswer(a.activityId);
  const keys = Object.keys(expected);
  const correct = keys.filter((key) => answer[key] === expected[key]).length;
  return {
    answer,
    correct,
    total: keys.length,
    passed: keys.length > 0 && correct === keys.length,
    scoreRatio: keys.length ? correct / keys.length : 0
  };
}

function mappingAnswer(activityId) {
  const answer = {};
  document.querySelectorAll(`#brick_${css(activityId)} [data-mapping-target]`).forEach(input => {
    answer[input.dataset.mappingTarget] = input.value;
  });
  document.querySelectorAll(`#brick_${css(activityId)} .mapping-zone`).forEach((zone) => {
    const item = zone.querySelector(".drag-item");
    answer[zone.dataset.target] = item?.dataset.value || "";
  });
  return answer;
}

function evaluateOrder(a) {
  const expected = a.config.correctOrder || [];
  const answer = orderAnswer(a.activityId);
  const correct = expected.filter((step, i) => answer[i] === step).length;
  return {
    answer,
    correct,
    total: expected.length,
    passed: expected.length > 0 && correct === expected.length,
    scoreRatio: expected.length ? correct / expected.length : 0
  };
}

function orderAnswer(activityId) {
  return [...document.querySelectorAll(`#order_${css(activityId)} .drag-item`)].map((item) => item.dataset.value);
}

function moveOrderStep(button, direction) {
  const item = button.closest('.order-item');
  const list = item.parentElement;
  const sibling = direction < 0 ? item.previousElementSibling : item.nextElementSibling;
  if (!sibling) return;
  if (direction < 0) list.insertBefore(item, sibling);
  else list.insertBefore(sibling, item);
  refreshOrderNumbers();
  const id = list.id.slice('order_'.length);
  const activity = findActivity(id);
  if (activity) saveDraft(activity.moduleId, id, {type:'drag_order', order:orderAnswer(id)});
}
function evaluateDecisionTable(a) {
  const rows = a.config.rows || [];
  const answer = decisionTableAnswer(a.activityId, rows);
  const correct = rows.filter((row, i) => answer[row.id || `r${i + 1}`] === row.correctOutcome).length;
  return {
    answer,
    correct,
    total: rows.length,
    passed: rows.length > 0 && correct === rows.length,
    scoreRatio: rows.length ? correct / rows.length : 0
  };
}

function decisionTableAnswer(activityId, rows) {
  const answer = {};
  (rows || []).forEach((row, i) => {
    answer[row.id || `r${i + 1}`] = $(`dt_${activityId}_${i}`)?.value || "";
  });
  return answer;
}

function evaluateImpactAnalysis(a) {
  const areas = a.config.areas || [];
  const expected = a.validation?.correctImpacts || a.config.correctImpacts || [];
  const selected = checkedValues(`impact_${a.activityId}`);
  const total = areas.length || expected.length;
  const correct = (areas.length ? areas.map((area) => area.id || area.label || area) : expected)
    .filter((id) => selected.includes(id) === expected.includes(id)).length;
  const threshold = Number(a.config.threshold || 0.8);
  const ratio = total ? correct / total : 0;
  return {
    answer: { selected },
    correct,
    total,
    passed: total > 0 && ratio >= threshold,
    scoreRatio: ratio
  };
}

function evaluateRestContract(a) {
  const answer = restContractAnswer(a.activityId);
  const expected = a.validation || a.config.validation || {};
  const checks = [
    sameValue(answer.method, expected.method),
    sameValue(answer.path, expected.path),
    sameSet(answer.pathParams, expected.pathParams || []),
    sameSet(answer.queryParams, normalizeQueryParams(expected.queryParams || [])),
    sameValue(answer.requestBody, expected.requestBody || "none"),
    sameValue(String(answer.successStatus || ""), String(expected.successStatus || "")),
    sameSet(answer.errorStatuses.map(String), (expected.errorStatuses || []).map(String)),
    sameSet(answer.responseFields, expected.responseFields || [])
  ];
  const correct = checks.filter(Boolean).length;
  return {
    answer,
    correct,
    total: checks.length,
    passed: correct === checks.length,
    scoreRatio: checks.length ? correct / checks.length : 0
  };
}

function restContractAnswer(activityId) {
  return {
    method: $(`rest_method_${activityId}`)?.value || "",
    path: $(`rest_path_${activityId}`)?.value || "",
    pathParams: checkedValues(`rest_path_params_${activityId}`),
    queryParams: checkedValues(`rest_query_params_${activityId}`),
    requestBody: $(`rest_body_${activityId}`)?.value || "",
    successStatus: Number($(`rest_success_${activityId}`)?.value || 0),
    errorStatuses: checkedValues(`rest_error_statuses_${activityId}`).map(Number),
    responseFields: checkedValues(`rest_response_fields_${activityId}`)
  };
}

function checkedValues(name) {
  return [...document.querySelectorAll(`[name="${css(name)}"]:checked`)].map((input) => input.value);
}

function sameValue(actual, expected) {
  return String(actual ?? "").trim() === String(expected ?? "").trim();
}

function sameSet(actual, expected) {
  const a = (actual || []).map((x) => String(x)).sort();
  const b = (expected || []).map((x) => String(x)).sort();
  return JSON.stringify(a) === JSON.stringify(b);
}

function normalizeQueryParams(items) {
  return (items || []).map(restOptionValue);
}

function isPlacementModule(moduleId) {
  const module = state.data?.modules?.find((m) => m.moduleId === moduleId);
  return module?.reviewMode === "placement";
}

function isLevelingModule(moduleId) {
  const module = state.data?.modules?.find((m) => m.moduleId === moduleId);
  return module?.reviewMode === "leveling";
}

function placementLevelLabel(level) {
  return ({
    0: "Below Level 1 / not confirmed",
    1: "Awareness",
    2: "Assisted practice",
    3: "Independent delivery",
    4: "Advanced ownership",
    5: "Expert leadership"
  })[level] || "Not enough data";
}

function buildLevelingResult(entries) {
  const threshold = 0.7;
  const stats = [1, 2, 3, 4].map((level) => {
    const items = entries.filter((entry) => entry.level === level);
    const score = items.reduce((sum, item) => sum + Number(item.score || 0), 0);
    const max = items.reduce((sum, item) => sum + Number(item.points || 0), 0);
    const pending = items.filter((item) => item.status === "pending_review").length;
    const ratio = max ? score / max : 0;
    const required = max ? Math.ceil(max * threshold) : 0;
    return {
      level,
      score,
      max,
      required,
      pending,
      percent: max ? Math.round(ratio * 100) : 0,
      ratio: Number(ratio.toFixed(2)),
      passed: max > 0 && ratio >= threshold && pending === 0,
      items
    };
  });
  let confirmedLevel = 0;
  for (const stat of stats) {
    if (!stat.passed) break;
    confirmedLevel = stat.level;
  }
  const blocked = stats.find((stat) => stat.max > 0 && !stat.passed);
  const pendingLevels = stats.filter((stat) => stat.pending > 0).map((stat) => stat.level);
  const strongest = stats.filter((stat) => stat.max > 0).slice().sort((a, b) => b.percent - a.percent)[0];
  const summary = blocked
    ? `Level ${blocked.level} is not confirmed yet: ${blocked.score}/${blocked.max} (${blocked.percent}%) scored, ${blocked.required}/${blocked.max} required. Higher-level scores are shown as strengths, but the confirmed level can only move upward after previous levels are confirmed.`
    : `All configured levels are confirmed.`;
  return {
    mode: "multi_skill",
    confirmedLevel,
    label: placementLevelLabel(confirmedLevel),
    threshold,
    stats,
    blockedLevel: blocked?.level || 0,
    blocked,
    strongest,
    pendingLevels,
    summary
  };
}

function levelBandForActivity(activity) {
  const cfg = activity.config || parseJson(activity.configJson, {});
  if (Number(cfg.levelBand || 0)) return Number(cfg.levelBand);
  const title = String(activity.title || "").toLowerCase();
  if (title.includes("traceability") || title.includes("mapping")) return 1;
  if (title.includes("discovery to delivery") || title.includes("process order")) return 2;
  if (title.includes("decision table") || title.includes("rest contract") || title.includes("sql data")) return 3;
  if (title.includes("impact analysis") || title.includes("open case")) return 4;
  if (title.includes("experience evidence")) return 5;
  return 1;
}

function levelingEntriesFromResults(moduleId, results) {
  const byId = new Map(results.map((result) => [result.activityId, result]));
  return activities(moduleId)
    .filter((activity) => activity.activityType !== "assessment_block" && activity.activityType !== "experience_evidence")
    .map((activity) => {
      const result = byId.get(activity.activityId) || {};
      return {
        title: activity.title || activity.activityId,
        type: activity.activityType,
        level: levelBandForActivity(activity),
        score: Number(result.score || 0),
        points: Number(activity.points || 0),
        status: result.validationStatus || "not_checked"
      };
    });
}

function levelingEntriesFromAttemptTasks(tasks) {
  return (tasks || [])
    .filter((task) => task.taskType !== "experience_evidence")
    .map((task) => ({
      title: task.title || task.assessmentTaskId,
      type: task.taskType,
      level: levelBandForActivity(task),
      score: Number(task.score || 0),
      points: Number(task.points || 0),
      status: task.validationStatus || "not_checked"
    }));
}

function renderLevelingSummary(result) {
  if (!result) return "";
  const title = result.confirmedLevel ? `Level ${result.confirmedLevel} confirmed` : "Level is not confirmed yet";
  const subtitle = result.confirmedLevel
    ? `${result.label}. The next level requires passing the next skill band.`
    : result.blocked
      ? `First blocking point: L${result.blocked.level} needs ${result.blocked.required}/${result.blocked.max}; current result is ${result.blocked.score}/${result.blocked.max}.`
      : result.label;
  return `
    <div class="level-summary">
      <div>
        <b>${esc(title)}</b>
        <span>${esc(subtitle)}</span>
      </div>
      <div class="level-explain">${esc(result.summary)}</div>
      <div class="level-grid">
        ${result.stats.map((stat) => `
          <div class="level-card ${stat.passed ? "passed" : ""}">
            <b>L${esc(stat.level)}</b>
            <span>${esc(stat.score)} / ${esc(stat.max)} (${esc(stat.percent)}%)</span>
            <small>Required: ${esc(stat.required)} / ${esc(stat.max)}</small>
            ${stat.pending ? `<small>${esc(stat.pending)} pending review</small>` : ""}
          </div>
        `).join("")}
      </div>
      ${result.strongest && result.strongest.percent > 0 ? `<div class="muted">Strongest current band: L${esc(result.strongest.level)} with ${esc(result.strongest.percent)}%.</div>` : ""}
    </div>
  `;
}

function buildPlacementResult(results) {
  const questionResults = results.flatMap((result) => result.answer?.questionResults || []);
  const difficultyItems = questionResults.filter((item) => item.questionLevel !== undefined && item.correct !== undefined);
  if (difficultyItems.length) {
    const threshold = 0.7;
    const stats = [1, 2, 3, 4, 5].map((level) => {
      const items = difficultyItems.filter((item) => Number(item.questionLevel) === level);
      const correct = items.filter((item) => item.correct).length;
      const ratio = items.length ? correct / items.length : 0;
      return { level, correct, total: items.length, ratio: Number(ratio.toFixed(2)), passed: items.length > 0 && ratio >= threshold };
    });
    let recommendedLevel = 0;
    for (const item of stats) {
      if (!item.total || !item.passed) break;
      recommendedLevel = item.level;
    }
    const totalCorrect = difficultyItems.filter((item) => item.correct).length;
    const totalQuestions = difficultyItems.length;
    const summary = `Recommended level: ${recommendedLevel ? `Level ${recommendedLevel}` : "Below Level 1"} (${placementLevelLabel(recommendedLevel)}). Evidence by difficulty: ${stats.map((s) => `L${s.level}: ${s.correct}/${s.total}`).join(", ")}. Threshold: ${Math.round(threshold * 100)}% on the level and all previous levels.`;
    return {
      mode: "difficulty",
      recommendedLevel,
      label: placementLevelLabel(recommendedLevel),
      averageLevel: recommendedLevel,
      totalCorrect,
      totalQuestions,
      threshold,
      stats,
      details: difficultyItems,
      summary
    };
  }

  const levels = [];
  const details = [];
  questionResults.forEach((item) => {
    const itemLevels = (item.selectedLevels || []).map(Number).filter(Number.isFinite);
    itemLevels.forEach((level) => levels.push(level));
    if (itemLevels.length) {
      const avg = itemLevels.reduce((sum, level) => sum + level, 0) / itemLevels.length;
      details.push({
        question: item.question,
        level: Math.round(avg),
        labels: item.selectedLabels || []
      });
    }
  });
  const averageLevel = levels.length ? levels.reduce((sum, level) => sum + level, 0) / levels.length : 1;
  const recommendedLevel = Math.max(1, Math.min(5, Math.round(averageLevel)));
  const counts = [1, 2, 3, 4, 5].map((level) => ({
    level,
    count: levels.filter((value) => Math.round(value) === level).length
  }));
  const summary = `Recommended level: Level ${recommendedLevel} (${placementLevelLabel(recommendedLevel)}). Average level: ${averageLevel.toFixed(2)}. Answers by level: ${counts.map((c) => `L${c.level}: ${c.count}`).join(", ")}.`;
  return {
    recommendedLevel,
    label: placementLevelLabel(recommendedLevel),
    averageLevel: Number(averageLevel.toFixed(2)),
    counts,
    details,
    summary
  };
}

function checkMapping(id) {
  const a = findActivity(id);
  const result = evaluateMapping(a);
  showResult(`result_${id}`, `Result: ${result.correct} / ${result.total}.`, result.passed ? "ok" : "warn");
}

function checkOrder(id) {
  const a = findActivity(id);
  const result = evaluateOrder(a);
  showResult(`result_${id}`, `Result: ${result.correct} / ${result.total}.`, result.passed ? "ok" : "warn");
}

function checkDecisionTable(id) {
  const a = findActivity(id);
  const result = evaluateDecisionTable(a);
  showResult(`result_${id}`, `Result: ${result.correct} / ${result.total}.`, result.passed ? "ok" : "warn");
}

function checkImpactAnalysis(id) {
  const a = findActivity(id);
  const result = evaluateImpactAnalysis(a);
  showResult(`result_${id}`, `Result: ${result.correct} / ${result.total}.`, result.passed ? "ok" : "warn");
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
    scheduleEvidenceRefresh();
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
    scheduleEvidenceRefresh();
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
  const expectedColumns = validation.expectedColumns || [];
  const expectedRows = validation.expectedRows || [];
  if (expectedColumns.length) {
    const actual = result.columns.map((col) => String(col)).sort();
    const expected = expectedColumns.map((col) => String(col)).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
  }
  if (!expectedRows.length) return true;
  const columns = expectedColumns.length ? expectedColumns : result.columns;
  const normalizeRow = (row) => columns.reduce((obj, col) => {
    obj[col] = String(row?.[col] ?? "");
    return obj;
  }, {});
  const sortRows = (rows) => rows.map(normalizeRow).map((row) => JSON.stringify(row)).sort();
  return JSON.stringify(sortRows(result.rows)) === JSON.stringify(sortRows(expectedRows));
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
  const tasks = activities(moduleId).filter((a) => !["assessment_block", "html_content", "video"].includes(a.activityType));
  const results = [];
  let error = "";
  const placement = isPlacementModule(moduleId);
  const leveling = isLevelingModule(moduleId);

  tasks.forEach((a) => {
    if (error && !autoExpired) return;
    if (a.activityType === "quiz") {
      let correct = 0;
      const selectedAnswers = [];
      const questionResults = [];
      const questions = a.config.questions || [];
      const difficultyPlacement = placement && a.config.placementMode === "difficulty";
      questions.forEach((q, i) => {
        const selected = [...document.querySelectorAll(`[name="q_${css(a.activityId)}_${i}"]:checked`)].map((n) => Number(n.value)).sort();
        if (placement && !selected.length && !autoExpired) {
          error = "Answer all placement questions before submitting.";
          return;
        }
        selectedAnswers.push(selected);
        if (placement) {
          const expected = (q.correctAnswers || []).slice().sort();
          const isCorrect = JSON.stringify(selected) === JSON.stringify(expected);
          if (difficultyPlacement && isCorrect) correct += 1;
          questionResults.push({
            question: q.question || `Question ${i + 1}`,
            questionLevel: difficultyPlacement ? Number(q.level || 1) : undefined,
            correct: difficultyPlacement ? isCorrect : undefined,
            selectedAnswers: selected,
            selectedLabels: selected.map((idx) => quizOptionLabel(q.options?.[idx] ?? idx)),
            correctAnswers: difficultyPlacement ? expected : undefined,
            correctLabels: difficultyPlacement ? expected.map((idx) => quizOptionLabel(q.options?.[idx] ?? idx)) : undefined,
            selectedLevels: selected.map((idx) => quizOptionLevel(q.options?.[idx])).filter(Number.isFinite)
          });
        } else if (JSON.stringify(selected) === JSON.stringify((q.correctAnswers || []).slice().sort())) {
          correct += 1;
        }
      });
      if (error && !autoExpired) return;
      const total = questions.length;
      if (placement) {
        const levels = questionResults.flatMap((item) => item.selectedLevels || []);
        const averageLevel = levels.length ? levels.reduce((sum, level) => sum + level, 0) / levels.length : 1;
        results.push({
          activityId: a.activityId,
          answer: { selectedAnswers, questionResults, averageLevel: Number(averageLevel.toFixed(2)), correct, total },
          validationStatus: "passed",
          validationOutput: "Placement responses captured.",
          score: difficultyPlacement
            ? (total ? Math.round(Number(a.points || 0) * correct / total) : 0)
            : Math.round(Number(a.points || 0) * Math.max(0, Math.min(1, averageLevel / 5)))
        });
        return;
      }
      results.push({
        activityId: a.activityId,
        answer: { correct, total, selectedAnswers },
        validationStatus: correct === total ? "passed" : "failed",
        score: total ? Math.round(Number(a.points || 0) * correct / total) : 0
      });
    } else if (a.activityType === "drag_mapping") {
      const result = evaluateMapping(a);
      results.push({
        activityId: a.activityId,
        answer: result.answer,
        validationStatus: result.passed ? "passed" : "failed",
        validationOutput: `Automatic mapping check: ${result.correct} / ${result.total}`,
        score: Math.round(Number(a.points || 0) * result.scoreRatio)
      });
    } else if (a.activityType === "drag_order") {
      const result = evaluateOrder(a);
      results.push({
        activityId: a.activityId,
        answer: { order: result.answer },
        validationStatus: result.passed ? "passed" : "failed",
        validationOutput: `Automatic order check: ${result.correct} / ${result.total}`,
        score: Math.round(Number(a.points || 0) * result.scoreRatio)
      });
    } else if (a.activityType === "decision_table") {
      const result = evaluateDecisionTable(a);
      results.push({
        activityId: a.activityId,
        answer: result.answer,
        validationStatus: result.passed ? "passed" : "failed",
        validationOutput: `Automatic decision table check: ${result.correct} / ${result.total}`,
        score: Math.round(Number(a.points || 0) * result.scoreRatio)
      });
    } else if (a.activityType === "impact_analysis") {
      const result = evaluateImpactAnalysis(a);
      results.push({
        activityId: a.activityId,
        answer: result.answer,
        validationStatus: result.passed ? "passed" : "failed",
        validationOutput: `Automatic impact analysis check: ${result.correct} / ${result.total}`,
        score: Math.round(Number(a.points || 0) * result.scoreRatio)
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
    } else if (["experience_evidence", "worksheet"].includes(a.activityType)) {
      const gate = evidenceGateStatus(a);
      if (!gate.unlocked) {
        results.push({
          activityId: a.activityId,
          answer: { locked: true, gate },
          validationStatus: "passed",
          validationOutput: `Seniority evidence not required. Automatic score ${gate.percent}% is below ${gate.requiredPercent}%.`,
          score: 0
        });
        return;
      }
      const prompts = a.config.prompts || defaultEvidencePrompts();
      const min = Number(a.config.minLength || 60);
      const responses = {};
      const missing = [];
      prompts.forEach((prompt, i) => {
        const key = prompt.id || `p${i + 1}`;
        const text = $(`evidence_${a.activityId}_${i}`)?.value.trim() || "";
        responses[key] = {
          label: prompt.label || prompt.question || `Evidence ${i + 1}`,
          text
        };
        if (text.length < min) missing.push(prompt.label || prompt.question || `Evidence ${i + 1}`);
      });
      if (missing.length && !autoExpired) {
        error = `Заполните ответы (минимум ${min} символов): ${missing.slice(0, 2).join(", ")}${missing.length > 2 ? "..." : ""}`;
        return;
      }
      results.push({
        activityId: a.activityId,
        answer: { responses },
        validationStatus: missing.length ? "not_checked" : "pending_review",
        validationOutput: a.activityType === "worksheet" ? "Рабочая тетрадь ожидает проверки ментором." : "Experience evidence requires reviewer confirmation.",
        score: 0
      });
    } else if (a.activityType === "rest_contract") {
      const result = evaluateRestContract(a);
      results.push({
        activityId: a.activityId,
        answer: result.answer,
        validationStatus: result.passed ? "passed" : "failed",
        validationOutput: `Automatic REST contract check: ${result.correct} / ${result.total}`,
        score: Math.round(Number(a.points || 0) * result.scoreRatio)
      });
    }
  });

  const placementResult = placement ? buildPlacementResult(results) : null;
  if (placementResult && results[0]) {
    results[0].answer.placementResult = placementResult;
    results[0].validationOutput = placementResult.summary;
  }
  const levelingResult = leveling ? buildLevelingResult(levelingEntriesFromResults(moduleId, results)) : null;
  if (levelingResult && results[0]) {
    results[0].answer.levelingResult = levelingResult;
    results[0].validationOutput = [results[0].validationOutput, levelingResult.summary].filter(Boolean).join("\n");
  }

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
    const message = placementResult
      ? `${autoExpired ? "Time is over. " : ""}Submitted. Recommended level: ${placementResult.recommendedLevel ? `Level ${placementResult.recommendedLevel}` : "Below Level 1"} (${placementResult.label}).${placementResult.mode === "difficulty" ? ` Evidence: ${placementResult.stats.map((s) => `L${s.level} ${s.correct}/${s.total}`).join(", ")}.` : ` Average level: ${placementResult.averageLevel}.`}`
      : levelingResult
        ? `${autoExpired ? "Time is over. " : ""}Submitted. ${levelingResult.confirmedLevel ? `Level ${levelingResult.confirmedLevel} confirmed.` : "Level is not confirmed yet."} ${levelingResult.blocked ? `First blocking point: L${levelingResult.blocked.level} needs ${levelingResult.blocked.required}/${levelingResult.blocked.max}; current result is ${levelingResult.blocked.score}/${levelingResult.blocked.max}.` : ""}`
      : `${autoExpired ? "Time is over. " : ""}Submitted. Attempt ${response.attemptNo} / ${response.effectiveMaxAttempts}. Status: ${response.resultStatus}.`;
    if (state.authToken) await api("/api/draft/clear-module", "POST", { moduleId }).catch(() => {});
    state.timedSubmitStarted = false;
    await load();
    showResult("assessment_result", message, "ok");
  } catch (e) {
    state.timedSubmitStarted = false;
    showResult("assessment_result", e.message, "error");
  }
}

async function loadAssessmentAttempts(moduleId = "", targetId = `assessment_reviews_${moduleId}`) {
  const box = $(targetId);
  if (!box) return;
  box.innerHTML = "<div class='muted'>Loading submissions...</div>";
  try {
    const response = await api("/api/admin/assessment-attempts", "POST", {
      token: state.adminToken,
      moduleId
    });
    const attempts = response.attempts || [];
    if (targetId === "knowledge_attempts") renderKnowledgeSummary(attempts);
    if (!attempts.length) {
      box.innerHTML = "<div class='result warn'>No submissions for this assessment yet.</div>";
      return;
    }
    box.innerHTML = attempts.map((attempt) => `
      <div class="attempt-row">
        <div>
          <b>${esc(attempt.userEmail)}</b>
          <div class="muted">Attempt ${esc(attempt.attemptNo)} - ${esc(formatDate(attempt.submittedAt))}</div>
        </div>
        <div class="attempt-score">
          <span class="badge ${statusBadgeClass(attempt.resultStatus)}">${esc(statusText(attempt.resultStatus))}</span>
          <span>${esc(attempt.totalScore)} / ${esc(attempt.maxScore)} (${esc(attempt.scorePercent)}%)</span>
          ${Number(attempt.pendingTaskCount || 0) ? `<span class="badge grey">${esc(attempt.pendingTaskCount)} pending</span>` : ""}
        </div>
        <button class="btn small" onclick="openAssessmentAttempt('${esc(attempt.attemptId)}')">Open</button>
      </div>
    `).join("");
  } catch (e) {
    box.innerHTML = `<div class="result error">${esc(e.message)}</div>`;
  }
}

function renderKnowledgeSummary(attempts) {
  const box = $("knowledge_summary");
  if (!box) return;
  const total = attempts.length;
  const passed = attempts.filter((a) => a.resultStatus === "passed").length;
  const failed = attempts.filter((a) => a.resultStatus === "failed").length;
  const pending = attempts.filter((a) => a.resultStatus === "pending_review").length;
  const students = new Set(attempts.map((a) => a.userEmail)).size;
  const avg = total ? Math.round(attempts.reduce((sum, a) => sum + Number(a.scorePercent || 0), 0) / total) : 0;
  box.innerHTML = `
    <div class="metric-card"><b>${esc(students)}</b><span>Students</span></div>
    <div class="metric-card"><b>${esc(total)}</b><span>Attempts</span></div>
    <div class="metric-card"><b>${esc(avg)}%</b><span>Average score</span></div>
    <div class="metric-card"><b>${esc(pending)}</b><span>Pending review</span></div>
    <div class="metric-card"><b>${esc(passed)}</b><span>Passed</span></div>
    <div class="metric-card"><b>${esc(failed)}</b><span>Failed</span></div>
  `;
}

async function openAssessmentAttempt(attemptId) {
  try {
    const response = await api("/api/admin/assessment-attempt", "POST", {
      token: state.adminToken,
      attemptId
    });
    const attempt = response.attempt;
    const tasks = response.tasks || [];
    modal(`
      ${modalHeader("Review submission")}
      <div class="review-summary">
        <div>
          <b>${esc(attempt.userEmail)}</b>
          <div class="muted">${esc(attempt.courseTitle || "")} - ${esc(attempt.moduleTitle || "")}</div>
        </div>
        <div class="attempt-score">
          <span class="badge ${statusBadgeClass(attempt.resultStatus)}">${esc(statusText(attempt.resultStatus))}</span>
          <span>${esc(attempt.totalScore)} / ${esc(attempt.maxScore)} (${esc(attempt.scorePercent)}%)</span>
        </div>
      </div>
      ${renderAttemptLevelingSummary(attempt, tasks)}
      ${tasks.map(renderAttemptTask).join("")}
      ${textArea("review_overall", "Overall review comment", attempt.reviewComment || "")}
      <button class="btn" onclick="submitAssessmentReview('${esc(attempt.attemptId)}','${esc(attempt.assessmentBlockId)}')">Save review</button>
      <div id="modalMsg"></div>
    `);
  } catch (e) {
    showResult("assessment_result", e.message, "error");
  }
}

function renderAttemptLevelingSummary(attempt, tasks) {
  const module = state.data?.modules?.find((m) => m.moduleId === attempt.assessmentBlockId);
  if ((attempt.reviewMode || module?.reviewMode) !== "leveling") return "";
  return renderLevelingSummary(buildLevelingResult(levelingEntriesFromAttemptTasks(tasks)));
}

function renderAttemptTask(task, index) {
  const max = Number(task.points || 0);
  const score = Number(task.score || 0);
  return `
    <section class="review-task" data-task-id="${esc(task.taskAttemptId)}">
      <div class="review-task-head">
        <div>
          <b>${esc(index + 1)}. ${esc(task.title || task.assessmentTaskId)}</b>
          <div class="muted">${esc(task.taskType)} - Max ${esc(max)} point(s)</div>
        </div>
        <span class="badge ${statusBadgeClass(task.validationStatus)}">${esc(statusText(task.validationStatus))}</span>
      </div>
      <div class="answer-box">${renderAttemptAnswer(task)}</div>
      ${task.interpreterOutput ? `<pre class="review-output">${esc(task.interpreterOutput)}</pre>` : ""}
      ${task.validationOutput ? `<pre class="review-output">${esc(task.validationOutput)}</pre>` : ""}
      <div class="grid-3">
        <div class="field">
          <label>Score</label>
          <input class="review-score" type="number" min="0" max="${esc(max)}" value="${esc(score)}">
        </div>
        ${selectField(`review_status_${task.taskAttemptId}`, "Status", [
          { value: "passed", label: "Passed" },
          { value: "failed", label: "Failed" },
          { value: "pending_review", label: "Pending review" },
          { value: "not_checked", label: "Not checked" }
        ], task.validationStatus || "pending_review").replace("<select", "<select class=\"review-status\"")}
        ${textField(`review_comment_${task.taskAttemptId}`, "Comment", task.reviewComment || "").replace("<input", "<input class=\"review-comment\"")}
      </div>
      ${task.reviewedBy ? `<div class="muted">Last reviewed by ${esc(task.reviewedBy)} ${esc(formatDate(task.reviewedAt))}</div>` : ""}
    </section>
  `;
}

function renderAttemptAnswer(task) {
  const answer = parseJson(task.answerJson, {});
  const config = parseJson(task.configJson, {});
  const validation = parseJson(task.validationJson, {});
  if (task.taskType === "open_answer") {
    return `<div class="answer-text">${esc(answer.text || "")}</div>`;
  }
  if (["experience_evidence", "worksheet"].includes(task.taskType)) {
    if (answer.locked) {
      return `<div class="result warn">Seniority evidence was not unlocked. Automatic score: ${esc(answer.gate?.percent ?? 0)}%, required: ${esc(answer.gate?.requiredPercent ?? 0)}%.</div>`;
    }
    const responses = answer.responses || {};
    const entries = Object.entries(responses);
    if (!entries.length) return `<div class="muted">No evidence submitted.</div>`;
    return entries.map(([key, item]) => {
      const label = typeof item === "object" && item !== null ? item.label : key;
      const text = typeof item === "object" && item !== null ? item.text : item;
      return `
        <div class="review-question">
          <b>${esc(label || key)}</b>
          <div class="answer-text">${esc(text || "")}</div>
        </div>
      `;
    }).join("");
  }
  if (task.taskType === "quiz") {
    const questions = config.questions || [];
    if (!questions.length || !Array.isArray(answer.selectedAnswers)) {
      return `<div class="muted">Correct answers saved: ${esc(answer.correct ?? 0)} / ${esc(answer.total ?? (questions.length || ""))}</div>`;
    }
    if (answer.placementResult) {
      if (answer.placementResult.mode === "difficulty") {
        return `
          <div class="result ok">${esc(answer.placementResult.summary || `Recommended level: Level ${answer.placementResult.recommendedLevel}`)}</div>
          ${questions.map((q, i) => {
            const selected = answer.selectedAnswers[i] || [];
            const selectedText = selected.map((idx) => quizOptionLabel(q.options?.[idx] ?? idx)).join(", ") || "No answer";
            const correctText = (q.correctAnswers || []).map((idx) => quizOptionLabel(q.options?.[idx] ?? idx)).join(", ");
            const item = (answer.questionResults || [])[i] || {};
            return `
              <div class="review-question">
                <b>${esc(q.question || `Question ${i + 1}`)}</b>
                <div>Student: ${esc(selectedText)}</div>
                <div class="muted">Difficulty: L${esc(q.level || item.questionLevel || "")} - ${item.correct ? "Correct" : "Incorrect"}</div>
                <div class="muted">Expected: ${esc(correctText)}</div>
              </div>
            `;
          }).join("")}
        `;
      }
      return `
        <div class="result ok">${esc(answer.placementResult.summary || `Recommended level: Level ${answer.placementResult.recommendedLevel}`)}</div>
        ${questions.map((q, i) => {
          const selected = answer.selectedAnswers[i] || [];
          const selectedText = selected.map((idx) => quizOptionLabel(q.options?.[idx] ?? idx)).join(", ") || "No answer";
          const levels = selected.map((idx) => quizOptionLevel(q.options?.[idx])).filter(Number.isFinite);
          return `
            <div class="review-question">
              <b>${esc(q.question || `Question ${i + 1}`)}</b>
              <div>Student: ${esc(selectedText)}</div>
              <div class="muted">Level: ${esc(levels.join(", ") || "Not selected")}</div>
            </div>
          `;
        }).join("")}
      `;
    }
    return questions.map((q, i) => {
      const selected = answer.selectedAnswers[i] || [];
      const selectedText = selected.map((idx) => quizOptionLabel(q.options?.[idx] ?? idx)).join(", ") || "No answer";
      const correctText = (q.correctAnswers || []).map((idx) => quizOptionLabel(q.options?.[idx] ?? idx)).join(", ");
      return `
        <div class="review-question">
          <b>${esc(q.question || `Question ${i + 1}`)}</b>
          <div>Student: ${esc(selectedText)}</div>
          <div class="muted">Correct: ${esc(correctText)}</div>
        </div>
      `;
    }).join("");
  }
  if (task.taskType === "sql_task") {
    const expected = config.validation || validation || {};
    const studentColumns = answer.rows?.length ? Object.keys(answer.rows[0]) : (expected.expectedColumns || []);
    return `
      <div class="review-question"><b>Student SQL</b><pre class="review-output">${esc(answer.query || JSON.stringify(answer, null, 2))}</pre></div>
      <div class="review-question">
        <b>Student result</b>
        ${tableHtml({ columns: studentColumns, rows: answer.rows || [] })}
      </div>
      ${renderSqlExpected(expected)}
    `;
  }
  if (task.taskType === "drag_mapping") {
    const mapping = config.correctMapping || {};
    return Object.keys(mapping).map((key) => `
      <div class="review-question">
        <b>${esc(key)}</b>
        <div>Student: ${esc(answer[key] || "No match")}</div>
        <div class="muted">Expected: ${esc(mapping[key])}</div>
      </div>
    `).join("");
  }
  if (task.taskType === "drag_order") {
    const got = answer.order || [];
    const expected = config.correctOrder || [];
    return `
      <div class="review-question"><b>Student order</b><div>${esc(got.join(" -> ") || "No answer")}</div></div>
      <div class="review-question"><b>Expected order</b><div>${esc(expected.join(" -> "))}</div></div>
    `;
  }
  if (task.taskType === "decision_table") {
    const rows = config.rows || [];
    return rows.map((row, i) => {
      const key = row.id || `r${i + 1}`;
      return `
        <div class="review-question">
          <b>${esc(row.case || row.label || key)}</b>
          <div>Conditions: ${esc((row.conditions || []).join(", "))}</div>
          <div>Student: ${esc(answer[key] || "No answer")}</div>
          <div class="muted">Expected: ${esc(row.correctOutcome || "")}</div>
        </div>
      `;
    }).join("");
  }
  if (task.taskType === "impact_analysis") {
    const selected = answer.selected || [];
    const expected = config.correctImpacts || validation.correctImpacts || [];
    const areas = config.areas || [];
    return `
      <div class="review-question"><b>Student selected</b><div>${esc(selected.join(", ") || "No answer")}</div></div>
      <div class="review-question"><b>Expected impacts</b><div>${esc(expected.join(", "))}</div></div>
      ${areas.map((area) => {
        const id = area.id || area.label || area;
        return `<div class="muted">${esc(id)} - ${esc(area.label || id)}</div>`;
      }).join("")}
    `;
  }
  if (task.taskType === "python_task") {
    return `<pre class="review-output">${esc(answer.code || JSON.stringify(answer, null, 2))}</pre>`;
  }
  if (task.taskType === "rest_contract") {
    const expected = config.validation || validation || {};
    return `
      <div class="grid-2">
        <div class="review-question"><b>Student method</b><div>${esc(answer.method || "")}</div></div>
        <div class="review-question"><b>Expected method</b><div>${esc(expected.method || "")}</div></div>
        <div class="review-question"><b>Student path</b><div>${esc(answer.path || "")}</div></div>
        <div class="review-question"><b>Expected path</b><div>${esc(expected.path || "")}</div></div>
        <div class="review-question"><b>Student path params</b><div>${esc((answer.pathParams || []).join(", ") || "None")}</div></div>
        <div class="review-question"><b>Expected path params</b><div>${esc((expected.pathParams || []).join(", ") || "None")}</div></div>
        <div class="review-question"><b>Student query params</b><div>${esc((answer.queryParams || []).join(", ") || "None")}</div></div>
        <div class="review-question"><b>Expected query params</b><div>${esc(normalizeQueryParams(expected.queryParams || []).join(", ") || "None")}</div></div>
        <div class="review-question"><b>Student body</b><div>${esc(answer.requestBody || "")}</div></div>
        <div class="review-question"><b>Expected body</b><div>${esc(expected.requestBody || "none")}</div></div>
        <div class="review-question"><b>Student success status</b><div>${esc(answer.successStatus || "")}</div></div>
        <div class="review-question"><b>Expected success status</b><div>${esc(expected.successStatus || "")}</div></div>
        <div class="review-question"><b>Student error statuses</b><div>${esc((answer.errorStatuses || []).join(", ") || "None")}</div></div>
        <div class="review-question"><b>Expected error statuses</b><div>${esc((expected.errorStatuses || []).join(", ") || "None")}</div></div>
        <div class="review-question"><b>Student response fields</b><div>${esc((answer.responseFields || []).join(", ") || "None")}</div></div>
        <div class="review-question"><b>Expected response fields</b><div>${esc((expected.responseFields || []).join(", ") || "None")}</div></div>
      </div>
    `;
  }
  return `<pre class="review-output">${esc(JSON.stringify(answer, null, 2))}</pre>`;
}

async function submitAssessmentReview(attemptId, moduleId) {
  try {
    const taskReviews = [...document.querySelectorAll(".review-task")].map((row) => ({
      taskAttemptId: row.dataset.taskId,
      score: Number(row.querySelector(".review-score")?.value || 0),
      validationStatus: row.querySelector(".review-status")?.value || "pending_review",
      reviewComment: row.querySelector(".review-comment")?.value || ""
    }));
    const response = await api("/api/admin/assessment/review", "POST", {
      token: state.adminToken,
      attemptId,
      taskReviews,
      reviewComment: val("review_overall")
    });
    showResult("modalMsg", `Saved. New result: ${statusText(response.resultStatus)} (${response.scorePercent}%).`, "ok");
    await load();
    setTimeout(() => loadAssessmentAttempts(state.adminView === "control" ? state.controlModule : moduleId, "knowledge_attempts"), 0);
  } catch (e) {
    showResult("modalMsg", e.message, "error");
  }
}

function statusText(status) {
  return ({
    pending_review: "Pending review",
    passed: "Passed",
    failed: "Failed",
    not_checked: "Not checked",
    error: "Error"
  })[status] || status || "Unknown";
}

function statusBadgeClass(status) {
  if (status === "passed") return "";
  if (status === "failed" || status === "error") return "danger";
  if (status === "pending_review") return "warn";
  return "grey";
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
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
        ${selectField("me_review", "Review mode", [{ value: "mixed", label: "Mixed" }, { value: "auto", label: "Auto" }, { value: "manual", label: "Manual" }, { value: "placement", label: "Placement" }, { value: "leveling", label: "Level assessment" }], module.reviewMode || "mixed")}
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
    ? [["html_content", "Material"], ["video", "Video player"], ["worksheet", "Worksheet"], ["quiz", "Quiz"], ["drag_mapping", "Drag mapping"], ["drag_order", "Drag order"], ["decision_table", "Decision table"], ["impact_analysis", "Impact analysis"], ["rest_contract", "REST contract"], ["sql_task", "SQL task"], ["python_task", "Python task"], ["open_answer", "Open answer"], ["experience_evidence", "Experience evidence"]]
    : [["html_content", "HTML content"], ["text", "Text"], ["image", "Image"], ["video", "Video player"], ["practice_quiz", "Practice quiz"], ["decision_table", "Decision table"], ["impact_analysis", "Impact analysis"], ["rest_contract", "REST contract"], ["drag_mapping", "Drag mapping"], ["drag_order", "Drag order"], ["sql_practice", "SQL practice"], ["python_practice", "Python practice"]];
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
  $("ae_type").onchange = () => renderActivityFields(activity, module);
  renderActivityFields(activity, module);
}

function renderActivityFields(activity, module = {}) {
  const type = val("ae_type");
  const cfg = activity?.config || {};
  const validation = activity?.validation || {};
  const isAssessment = module.moduleType === "assessment";
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
    box.innerHTML = textArea("ae_mapping_scenario", "Scenario", cfg.scenario || "") + selectField("ae_mapping_mode", "Interaction", [{value:"drag",label:"Drag and drop"},{value:"select",label:"Select matching values"}], cfg.inputMode || "drag") + `<div class="grid-2">${textField("ae_left_title", "Left title", cfg.leftTitle || "Targets")}${textField("ae_right_title", "Right title", cfg.rightTitle || "Values")}</div><div id="mappingPairs"></div><button class="btn ghost small" onclick="addPair()">+ Add pair</button>`;
    const mapping = cfg.correctMapping || {};
    const left = cfg.leftItems || Object.keys(mapping);
    (left.length ? left : [""]).forEach((item) => addPair(item, mapping[item] || ""));
  } else if (type === "drag_order") {
    box.innerHTML = textField("ae_question", "Question", cfg.question || "") + `<div id="orderSteps"></div><button class="btn ghost small" onclick="addStep()">+ Add step</button>`;
    (cfg.correctOrder || cfg.steps || [""]).forEach((step) => addStep(step));
  } else if (type === "decision_table") {
    box.innerHTML = textArea("ae_decision_scenario", "Scenario", cfg.scenario || activity?.content || "") +
      textArea("ae_decision_conditions", "Conditions, one per line", (cfg.conditions || ["Condition A", "Condition B"]).join("\n"), true) +
      textArea("ae_decision_outcomes", "Outcome options, comma-separated", (cfg.outcomes || ["Approve", "Reject", "Review"]).join(", ")) +
      textArea("ae_decision_rows", "Rows: Case | condition values comma-separated | correct outcome", decisionRowsToText(cfg.rows || []), true);
  } else if (type === "impact_analysis") {
    box.innerHTML = textArea("ae_impact_scenario", "Scenario", cfg.scenario || activity?.content || "") +
      textArea("ae_impact_areas", "Impact areas, one id|label|description per line", impactAreasToText(cfg.areas || defaultImpactAreas()), true) +
      textArea("ae_impact_correct", "Correct impacted area ids, comma-separated", (cfg.correctImpacts || validation.correctImpacts || []).join(", ")) +
      numberField("ae_impact_threshold", "Pass threshold, 0-1", cfg.threshold || 0.8);
  } else if (type === "sql_practice" || type === "sql_task") {
    const schemas = state.data.sqlSchemas.map((s) => ({ value: s.schemaId, label: s.title || s.schemaId }));
    box.innerHTML = selectField("ae_schema", "Schema", schemas, cfg.databaseSchemaId || schemas[0]?.value || "") +
      textArea("ae_instructions", "Instructions", cfg.instructions || activity?.content || "") +
      textArea("ae_query", "Starter SQL", cfg.defaultQuery || "", true) +
      textArea("ae_expected_query", "Пример правильного SQL (только для ментора)", cfg.validation?.expectedQuery || validation.expectedQuery || "", true) +
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
  } else if (["experience_evidence", "worksheet"].includes(type)) {
    const prompts = cfg.prompts || defaultEvidencePrompts();
    box.innerHTML = textArea("ae_evidence_instructions", "Instructions", activity?.content || cfg.instructions || "Provide concrete examples that help the reviewer confirm the recommended BA level.") +
      numberField("ae_evidence_min", "Minimum length per field", cfg.minLength || 60) +
      (type === "worksheet" ? "" : `<label class="check-line"><input id="ae_evidence_unlock_enabled" type="checkbox" ${cfg.unlock ? "checked" : ""}> Unlock only after high automatic score</label>` +
      numberField("ae_evidence_unlock_percent", "Unlock threshold, %", cfg.unlock?.minAutoScorePercent || 80)) +
      `<div id="evidencePrompts"></div><button class="btn ghost small" onclick="addEvidencePrompt()">+ Add evidence prompt</button>`;
    prompts.forEach((prompt) => addEvidencePrompt(prompt));
  } else if (type === "rest_contract") {
    const v = cfg.validation || validation || {};
    box.innerHTML = textArea("ae_rest_scenario", "Scenario", cfg.scenario || activity?.content || "") +
      textArea("ae_rest_methods", "Method options, comma-separated", (cfg.methodOptions || ["GET", "POST", "PUT", "PATCH", "DELETE"]).join(", ")) +
      textField("ae_rest_method", "Correct method", v.method || "GET") +
      textArea("ae_rest_paths", "Path options, one per line", (cfg.pathOptions || [v.path || "/api/clients/{clientCode}/accounts"]).join("\n"), true) +
      textField("ae_rest_path", "Correct path", v.path || "/api/clients/{clientCode}/accounts") +
      textArea("ae_rest_path_params", "Path param options, comma-separated", (cfg.pathParamOptions || v.pathParams || ["clientCode"]).join(", ")) +
      textArea("ae_rest_path_params_correct", "Correct path params, comma-separated", (v.pathParams || ["clientCode"]).join(", ")) +
      textArea("ae_rest_query_params", "Query param options, one name=value per line", queryParamsToLines(cfg.queryParamOptions || v.queryParams || [{ name: "status", value: "active" }]), true) +
      textArea("ae_rest_query_params_correct", "Correct query params, one name=value per line", queryParamsToLines(v.queryParams || [{ name: "status", value: "active" }]), true) +
      textArea("ae_rest_body_options", "Request body options, comma-separated", (cfg.requestBodyOptions || ["none", "json"]).join(", ")) +
      textField("ae_rest_body", "Correct request body", v.requestBody || "none") +
      textArea("ae_rest_success_options", "Success status options, comma-separated", (cfg.successStatusOptions || [200, 201, 204]).join(", ")) +
      numberField("ae_rest_success", "Correct success status", v.successStatus || 200) +
      textArea("ae_rest_error_options", "Error status options, comma-separated", (cfg.errorStatusOptions || [400, 401, 403, 404, 409, 422, 500]).join(", ")) +
      textArea("ae_rest_errors", "Correct error statuses, comma-separated", (v.errorStatuses || [400, 401, 404]).join(", ")) +
      textArea("ae_rest_response_options", "Response field options, one per line", (cfg.responseFieldOptions || v.responseFields || ["clientCode", "accounts[].accountNumber", "accounts[].currency"]).join("\n"), true) +
      textArea("ae_rest_response_fields", "Correct response fields, one per line", (v.responseFields || ["clientCode", "accounts[].accountNumber", "accounts[].currency"]).join("\n"), true);
  }

  if (isAssessment && ["worksheet", "quiz", "drag_mapping", "drag_order", "decision_table", "impact_analysis", "sql_task", "python_task", "open_answer", "rest_contract", "experience_evidence"].includes(type)) {
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

function addAnswer(button, option = "", isCorrect = false) {
  const host = button.parentElement.querySelector(".answers");
  const row = document.createElement("div");
  row.className = "answer-row";
  const text = quizOptionLabel(option);
  const level = quizOptionLevel(option) ?? "";
  row.innerHTML = `<input class="answer-text" placeholder="Answer option" value="${esc(text)}"><input class="answer-level" type="number" min="1" max="5" placeholder="Level" value="${esc(level)}"><label><input class="answer-correct" type="checkbox" ${isCorrect ? "checked" : ""}> Correct</label><button class="btn danger small" onclick="this.parentElement.remove()">X</button>`;
  host.appendChild(row);
}

function lines(value) {
  return String(value || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

function csv(value) {
  return String(value || "").split(",").map((x) => x.trim()).filter(Boolean);
}

function intCsv(value) {
  return csv(value).map((x) => Number(x)).filter((x) => !Number.isNaN(x));
}

function queryParamsToLines(items) {
  return (items || []).map((item) => typeof item === "string" ? item : queryLabel(item)).join("\n");
}

function parseQueryParams(value) {
  return lines(value).map((line) => {
    const index = line.indexOf("=");
    if (index < 0) return { name: line, value: "" };
    return { name: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
  }).filter((item) => item.name);
}

function decisionRowsToText(rows) {
  return (rows || []).map((row) => `${row.case || row.label || ""} | ${(row.conditions || []).join(", ")} | ${row.correctOutcome || ""}`).join("\n");
}

function parseDecisionRows(value) {
  return lines(value).map((line, i) => {
    const parts = line.split("|").map((part) => part.trim());
    return {
      id: `r${i + 1}`,
      case: parts[0] || `Case ${i + 1}`,
      conditions: csv(parts[1] || ""),
      correctOutcome: parts[2] || ""
    };
  }).filter((row) => row.case && row.correctOutcome);
}

function defaultImpactAreas() {
  return [
    { id: "ui", label: "UI", description: "Screens, fields, labels, validation messages" },
    { id: "api", label: "API", description: "Endpoint contract, request/response, status codes" },
    { id: "database", label: "Database", description: "Tables, fields, migration, constraints" },
    { id: "reports", label: "Reports", description: "Operational or analytical reports" },
    { id: "notifications", label: "Notifications", description: "Email, SMS, in-app notifications" },
    { id: "permissions", label: "Permissions", description: "Roles, access rights, audit" },
    { id: "qa", label: "QA regression", description: "Regression scope and test data" },
    { id: "operations", label: "Operations", description: "Back-office procedures and support" }
  ];
}

function impactAreasToText(areas) {
  return (areas || []).map((area) => `${area.id || area.label || area}|${area.label || area.id || area}|${area.description || ""}`).join("\n");
}

function parseImpactAreas(value) {
  return lines(value).map((line) => {
    const parts = line.split("|").map((part) => part.trim());
    return { id: parts[0], label: parts[1] || parts[0], description: parts[2] || "" };
  }).filter((area) => area.id);
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

function addEvidencePrompt(prompt = {}) {
  const row = document.createElement("div");
  row.className = "editor-section evidence-prompt-row";
  row.innerHTML = `
    <div class="repeat-row">
      <input class="evidence-label" placeholder="Prompt label" value="${esc(prompt.label || prompt.question || "")}">
      <button class="btn danger small" onclick="this.closest('.evidence-prompt-row').remove()">Remove</button>
    </div>
    <input class="evidence-id" placeholder="Stable id" value="${esc(prompt.id || "")}">
    <textarea class="evidence-hint" placeholder="Reviewer/student hint">${esc(prompt.hint || "")}</textarea>
    <textarea class="evidence-placeholder" placeholder="Placeholder shown inside answer field">${esc(prompt.placeholder || "")}</textarea>
  `;
  $("evidencePrompts").appendChild(row);
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
          const rows = [...q.querySelectorAll(".answer-row")];
          const hasLevels = rows.some((row) => row.querySelector(".answer-level")?.value !== "");
          const options = rows.map((row) => {
            const text = row.querySelector(".answer-text")?.value || "";
            const level = Number(row.querySelector(".answer-level")?.value || 0);
            return hasLevels ? { text, level: Number.isFinite(level) && level > 0 ? level : null } : text;
          });
          const correctAnswers = [...q.querySelectorAll(".answer-correct")].map((input, j) => input.checked ? j : null).filter((x) => x !== null);
          return { id: `q${i + 1}`, question: q.querySelector(".q-text").value, options, correctAnswers };
        })
      };
    } else if (type === "drag_mapping") {
      cfg = { scenario: val("ae_mapping_scenario"), inputMode: val("ae_mapping_mode") || "drag", leftTitle: val("ae_left_title"), rightTitle: val("ae_right_title"), leftItems: [], rightItems: [], correctMapping: {} };
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
    } else if (type === "decision_table") {
      payload.content = val("ae_decision_scenario");
      cfg = {
        scenario: val("ae_decision_scenario"),
        conditions: lines(val("ae_decision_conditions")),
        outcomes: csv(val("ae_decision_outcomes")),
        rows: parseDecisionRows(val("ae_decision_rows"))
      };
      validation = { validationMode: "decision_table" };
    } else if (type === "impact_analysis") {
      payload.content = val("ae_impact_scenario");
      validation = { validationMode: "impact_analysis", correctImpacts: csv(val("ae_impact_correct")) };
      cfg = {
        scenario: val("ae_impact_scenario"),
        areas: parseImpactAreas(val("ae_impact_areas")),
        correctImpacts: validation.correctImpacts,
        threshold: Number(val("ae_impact_threshold") || 0.8)
      };
    } else if (type === "sql_practice" || type === "sql_task") {
      validation = {
        expectedColumns: val("ae_columns").split(",").map((x) => x.trim()).filter(Boolean),
        expectedRows: parseJson(val("ae_rows"), []),
        expectedQuery: val("ae_expected_query")
      };
      cfg = { databaseSchemaId: val("ae_schema"), instructions: val("ae_instructions"), defaultQuery: val("ae_query"), validation };
    } else if (type === "python_practice" || type === "python_task") {
      validation = { validationMode: "stdout_match", expectedOutput: val("ae_python_output") };
      cfg = { runtime: "pyodide", instructions: val("ae_instructions"), starterCode: val("ae_python_code"), validation };
    } else if (type === "open_answer") {
      payload.content = val("ae_description");
      cfg = { minLength: Number(val("ae_min") || 0), placeholder: val("ae_placeholder") };
      validation = { validationMode: "manual", minLength: cfg.minLength };
    } else if (["experience_evidence", "worksheet"].includes(type)) {
      payload.manualReviewRequired = true;
      payload.content = val("ae_evidence_instructions");
      cfg = {
        instructions: val("ae_evidence_instructions"),
        allowPaste: type === "worksheet",
        minLength: Number(val("ae_evidence_min") || 60),
        unlock: checked("ae_evidence_unlock_enabled") ? { minAutoScorePercent: Number(val("ae_evidence_unlock_percent") || 80) } : null,
        prompts: [...document.querySelectorAll(".evidence-prompt-row")].map((row, i) => ({
          id: row.querySelector(".evidence-id")?.value || `p${i + 1}`,
          label: row.querySelector(".evidence-label")?.value || `Evidence ${i + 1}`,
          hint: row.querySelector(".evidence-hint")?.value || "",
          placeholder: row.querySelector(".evidence-placeholder")?.value || ""
        })).filter((prompt) => prompt.label)
      };
      validation = { validationMode: "manual", minLength: cfg.minLength };
    } else if (type === "rest_contract") {
      payload.content = val("ae_rest_scenario");
      validation = {
        method: val("ae_rest_method"),
        path: val("ae_rest_path"),
        pathParams: csv(val("ae_rest_path_params_correct")),
        queryParams: parseQueryParams(val("ae_rest_query_params_correct")),
        requestBody: val("ae_rest_body") || "none",
        successStatus: Number(val("ae_rest_success") || 200),
        errorStatuses: intCsv(val("ae_rest_errors")),
        responseFields: lines(val("ae_rest_response_fields"))
      };
      cfg = {
        scenario: val("ae_rest_scenario"),
        methodOptions: csv(val("ae_rest_methods")),
        pathOptions: lines(val("ae_rest_paths")),
        pathParamOptions: csv(val("ae_rest_path_params")),
        queryParamOptions: parseQueryParams(val("ae_rest_query_params")),
        requestBodyOptions: csv(val("ae_rest_body_options")),
        successStatusOptions: intCsv(val("ae_rest_success_options")),
        errorStatusOptions: intCsv(val("ae_rest_error_options")),
        responseFieldOptions: lines(val("ae_rest_response_options")),
        validation
      };
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
