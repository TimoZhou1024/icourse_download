// ==UserScript==
// @name         iCourse Batch Video Downloader
// @namespace    https://icourse.fudan.edu.cn/
// @version      0.1.0
// @description  Collect and download/export signed video links for Fudan iCourse course playback videos.
// @author       Codex
// @match        https://icourse.fudan.edu.cn/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_notification
// @grant        GM_addStyle
// @connect      icourse.fudan.edu.cn
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  const TENANT_CODE = new URL(location.href).searchParams.get("tenant_code") || "222";
  const COURSE_PAGE_SIZE = 50;
  const SIGNED_URL_TTL_HINT_MS = 30 * 60 * 1000;
  const CAPTURE_TIMEOUT_MS = 35000;
  const CAPTURE_SECONDARY_TIMEOUT_MS = 12000;
  const CAPTURE_CONFIRM_TIMEOUT_MS = 120000;
  const STREAM_POLICY_MAIN = "main";
  const STREAM_POLICY_ALL = "all";
  const STORAGE_KEYS = {
    confirmed: "icourseBatchDownloader.confirmed.v1",
    settings: "icourseBatchDownloader.settings.v1"
  };

  const state = {
    confirmed: Boolean(GM_getValue(STORAGE_KEYS.confirmed, false)),
    settings: Object.assign({
      streamPolicy: STREAM_POLICY_MAIN,
      includeUnavailable: false
    }, safeJsonParse(GM_getValue(STORAGE_KEYS.settings, "{}"), {})),
    user: null,
    courses: [],
    groupedCourses: new Map(),
    courseDetails: new Map(),
    subInfos: new Map(),
    selections: new Set(),
    expandedCourses: new Set(),
    expandedSubs: new Set(),
    logs: [],
    busy: false,
    filter: ""
  };

  let ui = null;

  addStyles();
  installNetworkObserver();
  createLauncher();

  function createLauncher() {
    const button = document.createElement("button");
    button.id = "icbd-launcher";
    button.type = "button";
    button.textContent = "iCourse 视频";
    button.addEventListener("click", openPanel);
    document.documentElement.appendChild(button);
  }

  function openPanel() {
    if (!ui) {
      ui = buildPanel();
      document.documentElement.appendChild(ui.root);
    }
    ui.root.classList.add("icbd-open");
    render();
    if (!state.confirmed) {
      showComplianceNotice();
    } else if (!state.courses.length && !state.busy) {
      loadCourses().catch(reportError);
    }
  }

  function buildPanel() {
    const root = el("div", { id: "icbd-root" }, [
      el("div", { className: "icbd-backdrop", "data-action": "close" }),
      el("section", { className: "icbd-panel", role: "dialog", "aria-label": "iCourse 视频批量工具" }, [
        el("header", { className: "icbd-header" }, [
          el("div", {}, [
            el("h2", {}, ["iCourse 视频批量工具"]),
            el("p", { className: "icbd-muted" }, ["仅处理当前登录账号有权限访问的课程资源"])
          ]),
          el("button", { className: "icbd-icon", type: "button", title: "关闭", "data-action": "close" }, ["x"])
        ]),
        el("div", { className: "icbd-toolbar" }, [
          el("input", { className: "icbd-search", type: "search", placeholder: "搜索课程或教师", "data-role": "search" }),
          el("select", { className: "icbd-select", "data-role": "stream-policy", title: "视频流策略" }, [
            el("option", { value: STREAM_POLICY_MAIN }, ["默认主视频流"]),
            el("option", { value: STREAM_POLICY_ALL }, ["默认全部视频流"])
          ]),
          el("button", { type: "button", "data-action": "refresh" }, ["刷新课程"]),
          el("button", { type: "button", "data-action": "expand-all" }, ["展开课程"]),
          el("button", { type: "button", "data-action": "collapse-all" }, ["折叠"])
        ]),
        el("main", { className: "icbd-main" }, [
          el("div", { className: "icbd-tree", "data-role": "tree" }),
          el("aside", { className: "icbd-side" }, [
            el("div", { className: "icbd-card" }, [
              el("h3", {}, ["任务"]),
              el("div", { className: "icbd-stat", "data-role": "stats" }, ["未选择视频"]),
              el("button", { type: "button", "data-action": "collect-selected" }, ["收集所选链接"]),
              el("button", { type: "button", "data-action": "download-selected" }, ["浏览器下载"]),
              el("button", { type: "button", "data-action": "refresh-signed" }, ["刷新 signed URL"])
            ]),
            el("div", { className: "icbd-card" }, [
              el("h3", {}, ["导出"]),
              el("button", { type: "button", "data-action": "export-json" }, ["导出 JSON"]),
              el("button", { type: "button", "data-action": "export-csv" }, ["导出 CSV"]),
              el("button", { type: "button", "data-action": "export-txt" }, ["导出 TXT"]),
              el("button", { type: "button", "data-action": "export-ps1" }, ["导出 yt-dlp PowerShell"])
            ]),
            el("div", { className: "icbd-card" }, [
              el("h3", {}, ["状态"]),
              el("div", { className: "icbd-log", "data-role": "log" })
            ])
          ])
        ])
      ])
    ]);

    root.addEventListener("click", handleClick);
    root.addEventListener("change", handleChange);
    root.addEventListener("input", handleInput);

    return {
      root,
      tree: root.querySelector('[data-role="tree"]'),
      log: root.querySelector('[data-role="log"]'),
      stats: root.querySelector('[data-role="stats"]'),
      search: root.querySelector('[data-role="search"]'),
      streamPolicy: root.querySelector('[data-role="stream-policy"]')
    };
  }

  function showComplianceNotice() {
    const modal = el("div", { className: "icbd-confirm" }, [
      el("div", { className: "icbd-confirm-box" }, [
        el("h3", {}, ["资源使用确认"]),
        el("p", {}, ["平台资源可能受版权和课程授权限制。请只处理你当前账号有权访问，且被允许用于个人学习或研究的课程资源。"]),
        el("p", {}, ["本脚本不绕过登录、权限、验证码、DRM 或平台限制；遇到平台规范确认弹窗时会暂停并要求你手动确认。"]),
        el("label", { className: "icbd-checkline" }, [
          el("input", { type: "checkbox", "data-role": "compliance-check" }),
          "我确认仅处理自己有权限访问且允许下载/保存的资源"
        ]),
        el("div", { className: "icbd-actions" }, [
          el("button", { type: "button", "data-action": "cancel-compliance" }, ["取消"]),
          el("button", { type: "button", disabled: true, "data-action": "accept-compliance" }, ["确认"])
        ])
      ])
    ]);
    ui.root.appendChild(modal);
  }

  function handleClick(event) {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (action === "close") {
      ui.root.classList.remove("icbd-open");
      return;
    }
    if (action === "cancel-compliance") {
      target.closest(".icbd-confirm")?.remove();
      ui.root.classList.remove("icbd-open");
      return;
    }
    if (action === "accept-compliance") {
      state.confirmed = true;
      GM_setValue(STORAGE_KEYS.confirmed, true);
      target.closest(".icbd-confirm")?.remove();
      loadCourses().catch(reportError);
      return;
    }
    if (!state.confirmed) {
      showComplianceNotice();
      return;
    }

    const courseId = target.dataset.courseId;
    const subKey = target.dataset.subKey;
    if (action === "refresh") loadCourses(true).catch(reportError);
    if (action === "expand-all") expandVisibleCourses();
    if (action === "collapse-all") collapseAll();
    if (action === "toggle-course" && courseId) toggleCourse(courseId);
    if (action === "load-course" && courseId) loadCourseDetail(courseId).catch(reportError);
    if (action === "toggle-sub" && subKey) toggleSub(subKey);
    if (action === "select-course" && courseId) selectCourse(courseId, target.checked);
    if (action === "select-sub" && subKey) selectSub(subKey, target.checked);
    if (action === "collect-selected") collectSelectedSignedUrls(false).catch(reportError);
    if (action === "refresh-signed") collectSelectedSignedUrls(true).catch(reportError);
    if (action === "download-selected") downloadSelected().catch(reportError);
    if (action === "export-json") exportSelected("json");
    if (action === "export-csv") exportSelected("csv");
    if (action === "export-txt") exportSelected("txt");
    if (action === "export-ps1") exportSelected("ps1");
  }

  function handleChange(event) {
    const target = event.target;
    if (target.matches('[data-role="stream-policy"]')) {
      state.settings.streamPolicy = target.value;
      GM_setValue(STORAGE_KEYS.settings, JSON.stringify(state.settings));
      applyStreamPolicyToLoadedStreams(true);
      render();
      return;
    }
    if (target.matches('[data-role="compliance-check"]')) {
      const button = ui.root.querySelector('[data-action="accept-compliance"]');
      if (button) button.disabled = !target.checked;
      return;
    }
    if (target.matches("[data-stream-key]")) {
      const key = target.dataset.streamKey;
      if (target.checked) state.selections.add(key);
      else state.selections.delete(key);
      renderStats();
    }
  }

  function handleInput(event) {
    const target = event.target;
    if (target.matches('[data-role="search"]')) {
      state.filter = target.value.trim().toLowerCase();
      render();
    }
  }

  async function loadCourses(force = false) {
    if (state.busy) return;
    if (state.courses.length && !force) {
      render();
      return;
    }
    state.busy = true;
    state.courses = [];
    state.groupedCourses = new Map();
    state.courseDetails.clear();
    state.subInfos.clear();
    state.selections.clear();
    log("正在读取当前账号课程列表...");
    render();
    try {
      state.user = await getCurrentUser();
      let page = 1;
      let total = Infinity;
      while (state.courses.length < total) {
        const url = `/portal/vlabpassportapi/v1/account-profile/course?model=&search=&course_type=&nowpage=${page}&per-page=${COURSE_PAGE_SIZE}`;
        const data = await fetchJson(url);
        const result = data?.params?.result || {};
        const rows = Array.isArray(result.data) ? result.data : [];
        total = Number(result.total || rows.length || state.courses.length);
        state.courses.push(...rows.map(normalizeCourse));
        if (!rows.length || state.courses.length >= total) break;
        page += 1;
      }
      buildCourseGroups();
      log(`已读取 ${state.courses.length} 门课程`);
    } finally {
      state.busy = false;
      render();
    }
  }

  async function getCurrentUser() {
    const data = await fetchJson("/userapi/v1/infosimple").catch(() => fetchJson("/eduuserapi/v1/infosimple"));
    const raw = data?.data || data?.params || data || {};
    return {
      userId: raw.user_id || raw.id || raw.UserId || "",
      username: raw.username || raw.Username || raw.user_name || "",
      realname: raw.realname || raw.Realname || raw.name || ""
    };
  }

  function normalizeCourse(raw) {
    return {
      id: String(raw.Id || raw.id || raw.course_id || raw.CourseId || ""),
      title: raw.Title || raw.title || "",
      teacher: raw.Teacher || raw.teacher || raw.realname || raw.teachers || "",
      term: raw.Term || raw.term || "",
      termName: raw.TermName || raw.term_name || raw.term || "未分组",
      structureName: raw.KkxyName || raw.structure_name || raw.KkxyName || "",
      progress: raw.progress || null,
      raw
    };
  }

  function buildCourseGroups() {
    state.groupedCourses = new Map();
    for (const course of state.courses) {
      const key = course.termName || "未分组";
      if (!state.groupedCourses.has(key)) state.groupedCourses.set(key, []);
      state.groupedCourses.get(key).push(course);
    }
  }

  async function loadCourseDetail(courseId) {
    if (state.courseDetails.has(courseId)) {
      render();
      return state.courseDetails.get(courseId);
    }
    const course = state.courses.find((item) => item.id === courseId);
    const student = encodeURIComponent(state.user?.username || course?.raw?.Username || "");
    log(`正在读取课程目录：${course?.title || courseId}`);
    const url = `/courseapi/v3/multi-search/get-course-detail?course_id=${encodeURIComponent(courseId)}${student ? `&student=${student}` : ""}`;
    const data = await fetchJson(url);
    const detail = normalizeCourseDetail(course, data?.data || {});
    state.courseDetails.set(courseId, detail);
    applyStreamPolicyToLoadedStreams();
    render();
    return detail;
  }

  function normalizeCourseDetail(course, raw) {
    const subs = flattenSubList(raw.sub_list).map((sub, index) => normalizeSub(course, sub, index));
    return {
      courseId: String(raw.id || course?.id || ""),
      title: raw.title || course?.title || "",
      termName: raw.term_name || course?.termName || "",
      teacher: raw.realname || course?.teacher || "",
      raw,
      subs
    };
  }

  function flattenSubList(subList) {
    const result = [];
    walk(subList);
    return result;

    function walk(value) {
      if (Array.isArray(value)) {
        value.forEach((item) => {
          if (item && typeof item === "object" && ("id" in item || "sub_id" in item || "sub_title" in item)) {
            result.push(item);
          } else {
            walk(item);
          }
        });
        return;
      }
      if (value && typeof value === "object") {
        Object.keys(value).sort(naturalCompare).forEach((key) => walk(value[key]));
      }
    }
  }

  function normalizeSub(course, raw, index) {
    const status = String(raw.sub_status || raw.status || "");
    const playbackStatus = String(raw.playback_status || "");
    return {
      courseId: course.id,
      courseTitle: course.title,
      termName: course.termName,
      id: String(raw.id || raw.sub_id || ""),
      subDataId: String(raw.sub_data_id || ""),
      title: raw.sub_title || raw.title || `小节 ${index + 1}`,
      type: raw.type || raw.olive_type || "",
      lecturerName: raw.lecturer_name || "",
      status,
      playbackStatus,
      index,
      available: status === "6" && playbackStatus !== "0",
      raw
    };
  }

  async function loadSubInfo(sub) {
    const key = getSubKey(sub);
    if (state.subInfos.has(key)) return state.subInfos.get(key);
    log(`正在解析视频流：${sub.courseTitle} / ${sub.title}`);
    const data = await fetchJson(`/courseapi/v3/portal-home-setting/get-sub-info?course_id=${encodeURIComponent(sub.courseId)}&sub_id=${encodeURIComponent(sub.id)}`);
    const info = normalizeSubInfo(sub, data?.data || {});
    state.subInfos.set(key, info);
    applyStreamPolicyToSub(info);
    render();
    return info;
  }

  function normalizeSubInfo(sub, raw) {
    const content = typeof raw.content === "string" ? safeJsonParse(raw.content, {}) : (raw.content || {});
    const streams = [];
    const seenUrls = new Set();

    addStream({
      source: "content.playback",
      label: "主视频流",
      rawUrl: content?.playback?.url || content?.save_playback?.contents || raw?.playurl?.["0"] || "",
      duration: raw.duration || content?.contents_duration || "",
      kind: "main",
      raw: content?.playback || content?.save_playback || null
    });

    const videoList = objectValues(raw.video_list);
    videoList.forEach((item, index) => {
      addStream({
        source: "video_list",
        label: streamLabel(item, index),
        rawUrl: item.preview_url || item.temp_preivew_url || "",
        thumb: item.thumb || "",
        duration: item.duration || "",
        kind: String(item.type || index),
        raw: item
      });
    });

    const segment = raw.segment_video_list || {};
    objectValues(segment).forEach((group) => {
      if (!group || typeof group !== "object") return;
      [
        ["teacher_list", "教师流"],
        ["student_list", "学生流"],
        ["ppt_list", "PPT流"]
      ].forEach(([field, label]) => {
        const item = group[field];
        if (item && typeof item === "object") {
          addStream({
            source: `segment_video_list.${field}`,
            label,
            rawUrl: item.preview_url || "",
            thumb: item.thumb || "",
            duration: item.duration || "",
            kind: field,
            raw: item
          });
        }
      });
    });

    objectValues(content?.file_list).forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const fileUrl = item.file_name || "";
      if (/\.(mp4|m3u8)(\?|$)/i.test(fileUrl)) {
        addStream({
          source: "content.file_list",
          label: index === 0 ? "文件流" : `文件流 ${index + 1}`,
          rawUrl: fileUrl,
          kind: item.file_type || "file",
          raw: item
        });
      }
    });

    if (!streams.length && raw?.playurl) {
      objectValues(raw.playurl).forEach((url, index) => {
        if (typeof url === "string" && url) {
          addStream({
            source: "playurl",
            label: index === 0 ? "播放流" : `播放流 ${index + 1}`,
            rawUrl: url,
            kind: "playurl",
            raw: url
          });
        }
      });
    }

    return {
      key: getSubKey(sub),
      sub,
      raw,
      content,
      isM3u8: String(raw.is_m3u8 || "").toLowerCase() === "yes" || streams.some((stream) => /\.m3u8(\?|$)/i.test(stream.rawUrl)),
      streams
    };

    function addStream(stream) {
      if (!stream.rawUrl) return;
      const normalized = normalizeUrl(stream.rawUrl);
      if (seenUrls.has(normalized)) return;
      seenUrls.add(normalized);
      const index = streams.length;
      streams.push(Object.assign(stream, {
        id: `${getSubKey(sub)}::${index}`,
        rawUrl: normalized,
        signedUrl: "",
        signedAt: 0,
        status: "raw",
        error: "",
        isMain: index === 0 || stream.kind === "main"
      }));
    }
  }

  function streamLabel(item, index) {
    const type = String(item?.type || "");
    if (type === "3") return "教师流";
    if (type === "4") return "学生流";
    if (type === "5") return "PPT流";
    return index === 0 ? "视频流" : `视频流 ${index + 1}`;
  }

  function applyStreamPolicyToLoadedStreams(force = false) {
    for (const info of state.subInfos.values()) {
      applyStreamPolicyToSub(info, force);
    }
  }

  function applyStreamPolicyToSub(info, force = false) {
    if (force) {
      info.streams.forEach((stream) => state.selections.delete(stream.id));
    }
    const selectedStreams = info.streams.filter((stream) => state.selections.has(stream.id));
    if (selectedStreams.length) return;
    const streams = state.settings.streamPolicy === STREAM_POLICY_ALL
      ? info.streams
      : info.streams.filter((stream) => stream.isMain || stream === info.streams[0]).slice(0, 1);
    streams.forEach((stream) => state.selections.add(stream.id));
  }

  function toggleCourse(courseId) {
    if (state.expandedCourses.has(courseId)) state.expandedCourses.delete(courseId);
    else {
      state.expandedCourses.add(courseId);
      loadCourseDetail(courseId).catch(reportError);
    }
    render();
  }

  function toggleSub(subKey) {
    if (state.expandedSubs.has(subKey)) state.expandedSubs.delete(subKey);
    else {
      state.expandedSubs.add(subKey);
      const sub = findSubByKey(subKey);
      if (sub) loadSubInfo(sub).catch(reportError);
    }
    render();
  }

  async function selectCourse(courseId, checked) {
    const detail = await loadCourseDetail(courseId);
    for (const sub of detail.subs) {
      await selectSub(getSubKey(sub), checked, false);
    }
    render();
  }

  async function selectSub(subKey, checked, shouldRender = true) {
    const sub = findSubByKey(subKey);
    if (!sub || !sub.available) {
      if (shouldRender) render();
      return;
    }
    const info = await loadSubInfo(sub);
    for (const stream of info.streams) {
      if (checked) {
        if (state.settings.streamPolicy === STREAM_POLICY_ALL || stream.isMain) state.selections.add(stream.id);
      } else {
        state.selections.delete(stream.id);
      }
    }
    if (shouldRender) render();
  }

  async function collectSelectedSignedUrls(force) {
    const tasks = getSelectedStreams();
    if (!tasks.length) {
      log("没有选择视频流");
      return;
    }
    state.busy = true;
    render();
    try {
      for (const task of tasks) {
        if (!force && task.stream.signedUrl && Date.now() - task.stream.signedAt < SIGNED_URL_TTL_HINT_MS) {
          continue;
        }
        try {
          task.stream.status = "capturing";
          task.stream.error = "";
          renderStats();
          const signedUrl = await captureSignedUrl(task);
          task.stream.signedUrl = signedUrl;
          task.stream.signedAt = Date.now();
          task.stream.status = "signed";
          log(`已捕获 signed URL：${task.sub.title} / ${task.stream.label}`);
        } catch (error) {
          task.stream.status = error.code === "NEED_CONFIRM" ? "need-confirm" : "failed";
          task.stream.error = error.message || String(error);
          log(`捕获失败：${task.sub.title} / ${task.stream.label} - ${task.stream.error}`, "warn");
        }
        render();
      }
    } finally {
      state.busy = false;
      render();
    }
  }

  async function captureSignedUrl(task) {
    const current = getCurrentPageSignedUrl(task);
    if (current) return current;
    const iframe = document.createElement("iframe");
    iframe.className = "icbd-capture-frame";
    iframe.src = livingRoomUrl(task.sub.courseId, task.sub.id);
    document.documentElement.appendChild(iframe);
    try {
      return await waitForIframeSignedUrl(iframe, task);
    } finally {
      setTimeout(() => {
        const shell = iframe.closest(".icbd-capture-shell");
        if (shell) shell.remove();
        else iframe.remove();
      }, 1000);
    }
  }

  function getCurrentPageSignedUrl(task) {
    const params = new URL(location.href).searchParams;
    if (!location.pathname.includes("/livingroom")) return "";
    if (params.get("course_id") !== task.sub.courseId || params.get("sub_id") !== task.sub.id) return "";
    return findMatchingVideoUrl(document, task.stream);
  }

  function waitForIframeSignedUrl(iframe, task) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      let confirmationRevealed = false;
      const timer = setInterval(() => {
        const timeout = confirmationRevealed
          ? CAPTURE_CONFIRM_TIMEOUT_MS
          : task.stream.isMain ? CAPTURE_TIMEOUT_MS : CAPTURE_SECONDARY_TIMEOUT_MS;
        if (Date.now() - started > timeout) {
          clearInterval(timer);
          reject(new Error(task.stream.isMain
            ? "等待播放器生成 signed URL 超时"
            : "播放器未加载该视频流；请在播放页切换到该流后重试，或导出裸链接"));
          return;
        }
        let doc;
        try {
          doc = iframe.contentDocument;
        } catch (error) {
          return;
        }
        if (!doc) return;
        const text = doc.body?.innerText || "";
        if (/关于平台资源使用的规范提示/.test(text)) {
          confirmationRevealed = true;
          revealCaptureFrame(iframe, task);
          return;
        }
        const signed = findMatchingVideoUrl(doc, task.stream);
        if (signed) {
          clearInterval(timer);
          resolve(signed);
        }
      }, 800);
    });
  }

  function revealCaptureFrame(iframe, task) {
    if (iframe.dataset.icbdRevealed === "1") return;
    iframe.dataset.icbdRevealed = "1";
    const shell = el("div", { className: "icbd-capture-shell" }, [
      el("div", { className: "icbd-capture-note" }, [
        el("strong", {}, ["需要手动确认平台规范"]),
        el("span", {}, [`请在下方页面完成确认：${task.sub.courseTitle} / ${task.sub.title} / ${task.stream.label}`]),
        el("button", {
          type: "button",
          title: "隐藏确认窗口",
          onclick: () => shell.classList.add("icbd-hidden")
        }, ["隐藏"])
      ])
    ]);
    document.documentElement.appendChild(shell);
    shell.appendChild(iframe);
    iframe.classList.add("icbd-capture-frame-visible");
    log(`请在弹出的确认窗口中手动确认平台规范：${task.sub.title} / ${task.stream.label}`, "warn");
  }

  function findMatchingVideoUrl(doc, stream) {
    const videos = Array.from(doc.querySelectorAll("video"));
    const candidates = videos
      .flatMap((video) => [video.currentSrc, video.src])
      .filter(Boolean);
    if (!candidates.length) return "";
    const rawPath = stripQuery(stream.rawUrl);
    const rawName = rawPath.split("/").pop();
    const exact = candidates.find((url) => stripQuery(url) === rawPath);
    if (exact) return exact;
    if (rawName) {
      const byName = candidates.find((url) => stripQuery(url).endsWith(`/${rawName}`));
      if (byName) return byName;
    }
    if (stream.isMain) return candidates[0] || "";
    return "";
  }

  async function downloadSelected() {
    const tasks = getSelectedStreams();
    if (!tasks.length) {
      log("没有选择视频流");
      return;
    }
    await collectSelectedSignedUrls(false);
    for (const task of getSelectedStreams()) {
      const url = task.stream.signedUrl;
      if (!url) continue;
      if (/\.m3u8(\?|$)/i.test(url)) {
        log(`跳过 HLS 浏览器下载，请导出 yt-dlp：${task.sub.title}`, "warn");
        continue;
      }
      await gmDownload(url, makeFileName(task));
    }
  }

  function gmDownload(url, name) {
    log(`开始下载：${name}`);
    return new Promise((resolve) => {
      GM_download({
        url,
        name,
        saveAs: false,
        onload: () => {
          log(`下载完成：${name}`);
          resolve();
        },
        onerror: (error) => {
          log(`下载失败：${name} - ${error?.error || "未知错误"}`, "warn");
          resolve();
        },
        ontimeout: () => {
          log(`下载超时：${name}`, "warn");
          resolve();
        }
      });
    });
  }

  function exportSelected(format) {
    const tasks = getSelectedStreams();
    if (!tasks.length) {
      log("没有选择视频流");
      return;
    }
    const rows = tasks.map(taskToExportRow);
    let content = "";
    let filename = `icourse-export-${formatTimestamp(new Date())}.${format}`;
    let mime = "text/plain;charset=utf-8";

    if (format === "json") {
      content = JSON.stringify(rows, null, 2);
      mime = "application/json;charset=utf-8";
    } else if (format === "csv") {
      content = toCsv(rows);
      mime = "text/csv;charset=utf-8";
    } else if (format === "txt") {
      content = rows.map((row) => [
        `${row.termName} / ${row.courseTitle} / ${row.subTitle} / ${row.streamLabel}`,
        `raw: ${row.rawUrl}`,
        `signed: ${row.signedUrl || ""}`,
        `status: ${row.status}${row.error ? ` (${row.error})` : ""}`
      ].join("\n")).join("\n\n");
    } else if (format === "ps1") {
      filename = `icourse-yt-dlp-${formatTimestamp(new Date())}.ps1`;
      content = toPowerShell(rows);
    }

    downloadText(content, filename, mime);
    GM_setClipboard(content);
    log(`已导出 ${rows.length} 条记录：${filename}，内容也已复制到剪贴板`);
  }

  function taskToExportRow(task) {
    return {
      termName: task.sub.termName,
      courseId: task.sub.courseId,
      courseTitle: task.sub.courseTitle,
      subId: task.sub.id,
      subTitle: task.sub.title,
      streamId: task.stream.id,
      streamLabel: task.stream.label,
      streamSource: task.stream.source,
      rawUrl: task.stream.rawUrl,
      signedUrl: task.stream.signedUrl || "",
      signedAt: task.stream.signedAt ? new Date(task.stream.signedAt).toISOString() : "",
      status: task.stream.status,
      error: task.stream.error || "",
      isM3u8: /\.m3u8(\?|$)/i.test(task.stream.rawUrl || task.stream.signedUrl || ""),
      filename: makeFileName(task),
      livingroomUrl: new URL(livingRoomUrl(task.sub.courseId, task.sub.id), location.origin).href
    };
  }

  function toPowerShell(rows) {
    const lines = [
      "# Generated by iCourse Batch Video Downloader",
      "# Install yt-dlp first: https://github.com/yt-dlp/yt-dlp",
      "$ErrorActionPreference = 'Stop'",
      ""
    ];
    for (const row of rows) {
      const url = row.signedUrl || row.rawUrl;
      lines.push(`# ${row.termName} / ${row.courseTitle} / ${row.subTitle} / ${row.streamLabel}`);
      if (!row.signedUrl) {
        lines.push("# WARNING: no signed URL captured yet; raw URL may not download directly.");
      }
      lines.push(`yt-dlp --continue --no-part --referer ${psQuote(row.livingroomUrl)} --user-agent ${psQuote(navigator.userAgent)} -o ${psQuote(row.filename)} ${psQuote(url)}`);
      lines.push("");
    }
    return lines.join("\n");
  }

  function toCsv(rows) {
    const headers = Object.keys(rows[0] || {});
    return [
      headers.join(","),
      ...rows.map((row) => headers.map((key) => csvCell(row[key])).join(","))
    ].join("\n");
  }

  function render() {
    if (!ui) return;
    ui.streamPolicy.value = state.settings.streamPolicy;
    ui.search.value = state.filter;
    renderTree();
    renderStats();
    renderLog();
  }

  function renderTree() {
    if (state.busy && !state.courses.length) {
      ui.tree.replaceChildren(el("div", { className: "icbd-empty" }, ["正在加载..."]));
      return;
    }
    if (!state.courses.length) {
      ui.tree.replaceChildren(el("div", { className: "icbd-empty" }, ["尚未读取课程"]));
      return;
    }
    const nodes = [];
    for (const [termName, courses] of state.groupedCourses) {
      const visibleCourses = courses.filter(courseMatchesFilter);
      if (!visibleCourses.length) continue;
      nodes.push(el("div", { className: "icbd-term" }, [
        el("div", { className: "icbd-term-title" }, [`${termName} (${visibleCourses.length})`]),
        ...visibleCourses.map(renderCourse)
      ]));
    }
    ui.tree.replaceChildren(...nodes);
  }

  function renderCourse(course) {
    const expanded = state.expandedCourses.has(course.id);
    const detail = state.courseDetails.get(course.id);
    const courseSelection = getCourseSelectionState(course.id);
    const checkbox = el("input", {
      type: "checkbox",
      "data-action": "select-course",
      "data-course-id": course.id
    });
    checkbox.checked = courseSelection.checked;
    checkbox.indeterminate = courseSelection.indeterminate;

    const children = [];
    if (expanded) {
      if (!detail) {
        children.push(el("div", { className: "icbd-sublist" }, [
          el("button", { type: "button", "data-action": "load-course", "data-course-id": course.id }, ["读取目录"])
        ]));
      } else {
        children.push(el("div", { className: "icbd-sublist" }, detail.subs.map(renderSub)));
      }
    }

    return el("div", { className: "icbd-course" }, [
      el("div", { className: "icbd-row icbd-course-row" }, [
        el("button", { type: "button", className: "icbd-caret", "data-action": "toggle-course", "data-course-id": course.id }, [expanded ? "v" : ">"]),
        checkbox,
        el("div", { className: "icbd-title" }, [
          el("strong", {}, [course.title || course.id]),
          el("span", { className: "icbd-muted" }, [`${course.teacher || "未知教师"} ${course.structureName || ""}`])
        ]),
        el("span", { className: "icbd-badge" }, [course.progress ? `进度 ${Math.round(Number(course.progress.subjectProgress || 0) * 100)}%` : ""])
      ]),
      ...children
    ]);
  }

  function renderSub(sub) {
    const subKey = getSubKey(sub);
    const expanded = state.expandedSubs.has(subKey);
    const info = state.subInfos.get(subKey);
    const statusText = getSubStatusText(sub);
    const checkbox = el("input", {
      type: "checkbox",
      disabled: !sub.available,
      "data-action": "select-sub",
      "data-sub-key": subKey
    });
    const selection = getSubSelectionState(subKey);
    checkbox.checked = selection.checked;
    checkbox.indeterminate = selection.indeterminate;

    const children = [];
    if (expanded) {
      if (!info && sub.available) {
        children.push(el("div", { className: "icbd-streams" }, [el("span", { className: "icbd-muted" }, ["正在读取视频流..."])]));
      } else if (info) {
        children.push(el("div", { className: "icbd-streams" }, info.streams.map(renderStream)));
      } else {
        children.push(el("div", { className: "icbd-streams" }, [el("span", { className: "icbd-muted" }, ["该小节当前不可回放"])]));
      }
    }

    return el("div", { className: "icbd-sub" }, [
      el("div", { className: "icbd-row icbd-sub-row" }, [
        el("button", { type: "button", className: "icbd-caret", "data-action": "toggle-sub", "data-sub-key": subKey }, [expanded ? "v" : ">"]),
        checkbox,
        el("div", { className: "icbd-title" }, [
          el("span", {}, [`${sub.index + 1}. ${sub.title}`]),
          el("span", { className: "icbd-muted" }, [sub.lecturerName || ""])
        ]),
        el("span", { className: `icbd-badge ${sub.available ? "icbd-ok" : "icbd-warn"}` }, [statusText])
      ]),
      ...children
    ]);
  }

  function renderStream(stream) {
    const checked = state.selections.has(stream.id);
    const checkbox = el("input", { type: "checkbox", "data-stream-key": stream.id });
    checkbox.checked = checked;
    return el("label", { className: "icbd-row icbd-stream-row" }, [
      checkbox,
      el("span", { className: "icbd-stream-label" }, [stream.label]),
      el("span", { className: "icbd-muted" }, [stream.source]),
      el("span", { className: `icbd-badge ${stream.status === "signed" ? "icbd-ok" : stream.status === "failed" || stream.status === "need-confirm" ? "icbd-warn" : ""}` }, [streamStatus(stream)])
    ]);
  }

  function renderStats() {
    if (!ui) return;
    const tasks = getSelectedStreams();
    const signed = tasks.filter((task) => task.stream.signedUrl).length;
    ui.stats.textContent = `已选择 ${tasks.length} 条视频流，已捕获 ${signed} 条 signed URL`;
  }

  function renderLog() {
    if (!ui) return;
    ui.log.replaceChildren(...state.logs.slice(-80).map((entry) => el("div", { className: `icbd-log-line icbd-${entry.level}` }, [
      el("span", { className: "icbd-muted" }, [entry.time]),
      " ",
      entry.message
    ])));
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function getCourseSelectionState(courseId) {
    const detail = state.courseDetails.get(courseId);
    if (!detail) return { checked: false, indeterminate: false };
    const subStates = detail.subs.map((sub) => getSubSelectionState(getSubKey(sub))).filter(Boolean);
    const selectable = subStates.filter((item) => item.total > 0);
    if (!selectable.length) return { checked: false, indeterminate: false };
    const selected = selectable.reduce((sum, item) => sum + item.selected, 0);
    const total = selectable.reduce((sum, item) => sum + item.total, 0);
    return { checked: selected > 0 && selected === total, indeterminate: selected > 0 && selected < total };
  }

  function getSubSelectionState(subKey) {
    const info = state.subInfos.get(subKey);
    if (!info) return { checked: false, indeterminate: false, selected: 0, total: 0 };
    const total = info.streams.length;
    const selected = info.streams.filter((stream) => state.selections.has(stream.id)).length;
    return { checked: selected > 0 && selected === total, indeterminate: selected > 0 && selected < total, selected, total };
  }

  function getSelectedStreams() {
    const tasks = [];
    for (const info of state.subInfos.values()) {
      for (const stream of info.streams) {
        if (state.selections.has(stream.id)) {
          tasks.push({ sub: info.sub, info, stream });
        }
      }
    }
    return tasks;
  }

  function findSubByKey(key) {
    for (const detail of state.courseDetails.values()) {
      const sub = detail.subs.find((item) => getSubKey(item) === key);
      if (sub) return sub;
    }
    return null;
  }

  function getSubKey(sub) {
    return `${sub.courseId}:${sub.id}`;
  }

  function getSubStatusText(sub) {
    if (sub.status === "2") return "未开始";
    if (sub.status === "3" || sub.playbackStatus === "0") return "回放生成中";
    if (sub.status === "6") return "可回放";
    return `状态 ${sub.status || "未知"}`;
  }

  function streamStatus(stream) {
    if (stream.status === "signed") return "已捕获";
    if (stream.status === "capturing") return "捕获中";
    if (stream.status === "need-confirm") return "需手动确认";
    if (stream.status === "failed") return "失败";
    if (/\.m3u8(\?|$)/i.test(stream.rawUrl)) return "HLS";
    return stream.isMain ? "主流" : "待捕获";
  }

  function expandVisibleCourses() {
    for (const course of state.courses.filter(courseMatchesFilter)) {
      state.expandedCourses.add(course.id);
      loadCourseDetail(course.id).catch(reportError);
    }
    render();
  }

  function collapseAll() {
    state.expandedCourses.clear();
    state.expandedSubs.clear();
    render();
  }

  function courseMatchesFilter(course) {
    if (!state.filter) return true;
    return [course.title, course.teacher, course.termName, course.structureName]
      .join(" ")
      .toLowerCase()
      .includes(state.filter);
  }

  function log(message, level = "info") {
    state.logs.push({ message, level, time: new Date().toLocaleTimeString() });
    renderLog();
  }

  function reportError(error) {
    console.error("[iCourse Batch Downloader]", error);
    log(error?.message || String(error), "warn");
    state.busy = false;
    render();
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(new URL(url, location.origin).href, {
      credentials: "include",
      headers: Object.assign({
        Accept: "application/json, text/plain, */*"
      }, options.headers || {}),
      method: options.method || "GET",
      body: options.body
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`响应不是 JSON: ${url}`);
    }
  }

  function installNetworkObserver() {
    const originalFetch = window.fetch;
    window.fetch = async function observedFetch(...args) {
      const response = await originalFetch.apply(this, args);
      rememberMediaResponse(args[0], response.url);
      return response;
    };
    const OriginalXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function ObservedXHR() {
      const xhr = new OriginalXHR();
      let requestUrl = "";
      const open = xhr.open;
      xhr.open = function (method, url, ...rest) {
        requestUrl = String(url || "");
        return open.call(xhr, method, url, ...rest);
      };
      xhr.addEventListener("load", () => rememberMediaResponse(requestUrl, xhr.responseURL));
      return xhr;
    };
  }

  function rememberMediaResponse(requestUrl, responseUrl) {
    const url = String(responseUrl || requestUrl || "");
    if (!/\.(mp4|m3u8)(\?|$)/i.test(url)) return;
    window.__icbdLastMediaUrls = window.__icbdLastMediaUrls || [];
    window.__icbdLastMediaUrls.unshift({ url, at: Date.now() });
    window.__icbdLastMediaUrls = window.__icbdLastMediaUrls.slice(0, 100);
  }

  function livingRoomUrl(courseId, subId) {
    return `/livingroom?course_id=${encodeURIComponent(courseId)}&sub_id=${encodeURIComponent(subId)}&tenant_code=${encodeURIComponent(TENANT_CODE)}`;
  }

  function makeFileName(task) {
    const ext = /\.m3u8(\?|$)/i.test(task.stream.signedUrl || task.stream.rawUrl) ? "m3u8" : "mp4";
    const index = String(task.sub.index + 1).padStart(2, "0");
    return [
      safePathPart(task.sub.termName || "未分组"),
      safePathPart(task.sub.courseTitle || task.sub.courseId),
      `${index}-${safePathPart(task.sub.title)}-${safePathPart(task.stream.label)}.${ext}`
    ].join("/");
  }

  function safePathPart(value) {
    return String(value || "")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "untitled";
  }

  function normalizeUrl(url) {
    if (!url) return "";
    return new URL(url, location.origin).href;
  }

  function stripQuery(url) {
    try {
      const parsed = new URL(url, location.origin);
      return `${parsed.origin}${parsed.pathname}`;
    } catch (error) {
      return String(url || "").split("?")[0];
    }
  }

  function objectValues(value) {
    if (!value || typeof value !== "object") return [];
    if (Array.isArray(value)) return value;
    return Object.keys(value)
      .filter((key) => key !== "now")
      .map((key) => value[key]);
  }

  function safeJsonParse(text, fallback) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return fallback;
    }
  }

  function naturalCompare(a, b) {
    return String(a).localeCompare(String(b), "zh-CN", { numeric: true });
  }

  function csvCell(value) {
    const text = value == null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function psQuote(value) {
    return `'${String(value || "").replace(/'/g, "''")}'`;
  }

  function formatTimestamp(date) {
    const pad = (num) => String(num).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }

  function downloadText(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === "className") node.className = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key in node && !key.startsWith("data-") && !key.startsWith("aria-")) node[key] = value;
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (child == null) continue;
      node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function addStyles() {
    GM_addStyle(`
      #icbd-launcher {
        position: fixed;
        right: 24px;
        bottom: 24px;
        z-index: 2147483000;
        border: 0;
        border-radius: 8px;
        padding: 10px 14px;
        background: #1769e0;
        color: #fff;
        font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 8px 24px rgba(0,0,0,.18);
        cursor: pointer;
      }
      #icbd-root { display: none; position: fixed; inset: 0; z-index: 2147483001; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1f2933; }
      #icbd-root.icbd-open { display: block; }
      .icbd-backdrop { position: absolute; inset: 0; background: rgba(15,23,42,.42); }
      .icbd-panel { position: absolute; inset: 48px; min-width: 920px; background: #fff; border-radius: 8px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,.28); }
      .icbd-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid #e5e7eb; }
      .icbd-header h2 { margin: 0 0 4px; font-size: 18px; letter-spacing: 0; }
      .icbd-header p, .icbd-card h3 { margin: 0; }
      .icbd-icon, .icbd-caret { border: 1px solid #d1d5db; background: #fff; border-radius: 6px; min-width: 28px; height: 28px; cursor: pointer; }
      .icbd-toolbar { display: flex; gap: 8px; align-items: center; padding: 12px 20px; border-bottom: 1px solid #e5e7eb; }
      .icbd-toolbar button, .icbd-card button, .icbd-actions button { border: 1px solid #cbd5e1; background: #fff; border-radius: 6px; padding: 8px 10px; cursor: pointer; }
      .icbd-card button { width: 100%; margin-top: 8px; text-align: left; }
      .icbd-toolbar button:hover, .icbd-card button:hover, .icbd-actions button:hover { background: #f8fafc; }
      .icbd-search { flex: 1; min-width: 220px; border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px 10px; }
      .icbd-select { border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px 10px; background: #fff; }
      .icbd-main { display: grid; grid-template-columns: minmax(0, 1fr) 280px; min-height: 0; flex: 1; }
      .icbd-tree { overflow: auto; padding: 12px 20px 24px; background: #f8fafc; }
      .icbd-side { overflow: auto; padding: 12px; border-left: 1px solid #e5e7eb; background: #fff; }
      .icbd-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; margin-bottom: 12px; background: #fff; }
      .icbd-term { margin-bottom: 14px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; overflow: hidden; }
      .icbd-term-title { padding: 10px 12px; background: #eef2f7; font-weight: 600; }
      .icbd-row { display: flex; align-items: center; gap: 8px; min-height: 36px; }
      .icbd-course-row { padding: 8px 12px; border-top: 1px solid #f1f5f9; }
      .icbd-sublist { padding: 0 0 8px 40px; }
      .icbd-sub-row { padding: 6px 12px; border-top: 1px solid #f1f5f9; }
      .icbd-streams { margin: 0 12px 8px 44px; border-left: 2px solid #e2e8f0; padding-left: 10px; }
      .icbd-stream-row { padding: 5px 0; }
      .icbd-title { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      .icbd-title strong, .icbd-title span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .icbd-muted { color: #64748b; font-size: 12px; }
      .icbd-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 48px; padding: 2px 6px; border-radius: 999px; background: #e2e8f0; color: #334155; font-size: 12px; white-space: nowrap; }
      .icbd-ok { background: #dcfce7; color: #166534; }
      .icbd-warn { background: #fef3c7; color: #92400e; }
      .icbd-stream-label { min-width: 72px; }
      .icbd-empty { padding: 48px; text-align: center; color: #64748b; }
      .icbd-stat { padding: 8px 0; color: #334155; }
      .icbd-log { height: 220px; overflow: auto; border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px; background: #0f172a; color: #dbeafe; font-size: 12px; }
      .icbd-log-line { margin-bottom: 4px; word-break: break-word; }
      .icbd-log-line.icbd-warn { color: #fde68a; }
      .icbd-confirm { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(15,23,42,.35); z-index: 2; }
      .icbd-confirm-box { width: min(560px, calc(100vw - 64px)); background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 20px 60px rgba(0,0,0,.24); }
      .icbd-confirm-box h3 { margin: 0 0 12px; }
      .icbd-checkline { display: flex; align-items: flex-start; gap: 8px; margin: 14px 0; }
      .icbd-actions { display: flex; justify-content: flex-end; gap: 8px; }
      .icbd-capture-frame { position: fixed; left: -1200px; top: 0; width: 960px; height: 640px; opacity: .01; pointer-events: none; z-index: -1; }
      .icbd-capture-shell { position: fixed; left: 24px; right: 24px; bottom: 24px; height: min(720px, calc(100vh - 48px)); z-index: 2147483002; display: flex; flex-direction: column; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; box-shadow: 0 20px 60px rgba(0,0,0,.32); overflow: hidden; }
      .icbd-capture-shell.icbd-hidden { display: none; }
      .icbd-capture-note { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-bottom: 1px solid #e5e7eb; background: #fff7ed; color: #7c2d12; }
      .icbd-capture-note span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .icbd-capture-note button { border: 1px solid #fed7aa; background: #fff; border-radius: 6px; padding: 6px 10px; cursor: pointer; }
      .icbd-capture-frame.icbd-capture-frame-visible { position: static; width: 100%; height: 100%; opacity: 1; pointer-events: auto; z-index: auto; border: 0; flex: 1; }
      @media (max-width: 980px) {
        .icbd-panel { inset: 12px; min-width: 0; }
        .icbd-main { grid-template-columns: 1fr; }
        .icbd-side { border-left: 0; border-top: 1px solid #e5e7eb; max-height: 320px; }
        .icbd-toolbar { flex-wrap: wrap; }
      }
    `);
  }
})();
