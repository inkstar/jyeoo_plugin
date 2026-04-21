(function () {
  const ROOT_ID = "jyeoo-select-all-root";
  const TOOLBAR_ID = "jyeoo-select-all-toolbar";
  const TOOLBAR_TITLE_ID = "jyeoo-select-all-toolbar-title";
  const TOOLBAR_ACTIONS_ID = "jyeoo-select-all-toolbar-actions";
  const TOGGLE_BUTTON_ID = "jyeoo-select-all-toggle";
  const BUTTON_ID = "jyeoo-select-all-button";
  const MULTI_BUTTON_ID = "jyeoo-select-all-multi-button";
  const STATUS_ID = "jyeoo-select-all-status";
  const LOG_ID = "jyeoo-select-all-log";
  const LOG_TRACK_ID = "jyeoo-select-all-log-track";
  const BUTTON_TEXT = "全选本页题目";
  const MULTI_BUTTON_TEXT = "选择多页试题";
  const LOG_PREFIX = "[JYEOO-PLUGIN]";
  const CLICK_DELAY_MS = 900;
  const PASS_GAP_MS = 2200;
  const PAGE_READY_RETRY_COUNT = 6;
  const PAGE_READY_RETRY_DELAY_MS = 1200;
  const MULTI_PAGE_TARGET_COUNT = 60;
  const MULTI_PAGE_STATE_KEY = "jyeoo-select-all-multi-state";
  const PANEL_PREFS_KEY = "jyeoo-select-all-panel-prefs";
  const SEARCH_PAGE_PATTERN = /\/[^/]+\/ques(?:\/|$)/i;
  const TARGET_TEXTS = [
    "选题",
    "加入试卷",
    "加入组卷",
    "加入我的试卷",
    "加入篮",
    "加入试题篮",
    "试题篮",
    "收藏到试卷",
    "加入选题",
    "加入收藏挑题",
    "选用本题"
  ];
  const EXCLUDED_TEXTS = ["取消", "移除", "删除", "已选", "取消选题"];
  let isRunning = false;
  let resumeScheduled = false;
  let dragState = null;

  function isVisible(node) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function normalizeText(text) {
    return (text || "").replace(/\s+/g, "").trim();
  }

  function getNodeSignature(node) {
    if (!(node instanceof Element)) {
      return "";
    }

    const parts = [
      node.textContent || "",
      node.getAttribute("title") || "",
      node.getAttribute("aria-label") || "",
      node.getAttribute("onclick") || "",
      node.getAttribute("data-action") || "",
      node.getAttribute("data-title") || "",
      node.getAttribute("data-original-title") || "",
      node.id || "",
      typeof node.className === "string" ? node.className : ""
    ];

    return normalizeText(parts.join(" "));
  }

  function shouldSkipActionNode(node) {
    if (!(node instanceof Element)) {
      return false;
    }

    const signature = getNodeSignature(node);
    if (
      signature.includes("i-subtract") ||
      signature.includes("subtract") ||
      signature.includes("移出试题篮") ||
      signature.includes("移除试题") ||
      signature.includes("移除") ||
      signature.includes("删除") ||
      signature.includes("已加入") ||
      signature.includes("已选")
    ) {
      return true;
    }

    return Boolean(node.querySelector(".i-subtract, .xs-icon.i-subtract"));
  }

  function isQuestionSearchPage() {
    return SEARCH_PAGE_PATTERN.test(window.location.pathname);
  }

  function loadMultiPageState() {
    try {
      const raw = window.sessionStorage.getItem(MULTI_PAGE_STATE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveMultiPageState(state) {
    try {
      window.sessionStorage.setItem(MULTI_PAGE_STATE_KEY, JSON.stringify(state));
    } catch {
      // ignore
    }
  }

  function clearMultiPageState() {
    try {
      window.sessionStorage.removeItem(MULTI_PAGE_STATE_KEY);
    } catch {
      // ignore
    }
  }

  function loadPanelPrefs() {
    try {
      const raw = window.localStorage.getItem(PANEL_PREFS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function savePanelPrefs(partial) {
    const nextPrefs = { ...loadPanelPrefs(), ...partial };
    try {
      window.localStorage.setItem(PANEL_PREFS_KEY, JSON.stringify(nextPrefs));
    } catch {
      // ignore
    }
  }

  function applyPanelPrefs() {
    const root = document.getElementById(ROOT_ID);
    if (!root) {
      return;
    }

    const prefs = loadPanelPrefs();
    if (typeof prefs.top === "number") {
      root.style.top = `${prefs.top}px`;
      root.style.bottom = "auto";
    }
    if (typeof prefs.right === "number") {
      root.style.right = `${prefs.right}px`;
    }
    root.classList.toggle("collapsed", Boolean(prefs.collapsed));

    const toggleButton = document.getElementById(TOGGLE_BUTTON_ID);
    if (toggleButton) {
      toggleButton.textContent = prefs.collapsed ? "+" : "−";
      toggleButton.title = prefs.collapsed ? "展开" : "隐藏";
    }
  }

  function scheduleMultiPageResume(delay = 1800) {
    const multiPageState = loadMultiPageState();
    if (!multiPageState?.active || resumeScheduled || isRunning) {
      return;
    }

    resumeScheduled = true;
    window.setTimeout(() => {
      resumeScheduled = false;
      const latestState = loadMultiPageState();
      if (latestState?.active && !isRunning) {
        void runSelectAll({
          multiPage: true,
          resumed: true,
          targetCount: latestState.targetCount || MULTI_PAGE_TARGET_COUNT
        });
      }
    }, delay);
  }

  function getQuestionBlocks() {
    const selectors = [
      ".list-box .queslist",
      ".list-box .ques-item",
      ".list-box .question-item",
      ".list-box .list-item",
      ".paper-list .queslist",
      "[data-qid]",
      "[data-questionid]",
      "[data-question-id]",
      "[id^='ques']",
      "[id*='ques_']"
    ];

    const nodes = Array.from(document.querySelectorAll(selectors.join(","))).filter(isVisible);
    if (nodes.length > 0) {
      return nodes;
    }

    return Array.from(document.querySelectorAll(".list-box > div, .list-box > li, .list-box > dl, .list-box > table"))
      .filter((node) => {
        if (!isVisible(node)) {
          return false;
        }

        if (node.closest(".paper-list")) {
          return false;
        }

        const text = normalizeText(node.textContent || "");
        const hasQuestionHints = text.includes("试题") || text.includes("解析") || text.includes("答案");
        if (!hasQuestionHints) {
          return false;
        }

        const hasSelectableControls = Array.from(
          node.querySelectorAll('input[type="checkbox"], [role="checkbox"], button, a, span, div, li, i')
        ).some((child) => {
          if (!isVisible(child)) {
            return false;
          }

          const childText = normalizeText(child.textContent || child.getAttribute?.("title") || "");
          const onclick = normalizeText(child.getAttribute?.("onclick") || "");
          return isTargetText(childText) || /add|paper|select|choose/i.test(onclick);
        });

        return hasSelectableControls;
      });
  }

  function shouldShowButton() {
    const bodyText = normalizeText(document.body?.innerText || "");
    const hasQuestionHints =
      bodyText.includes("组卷") ||
      bodyText.includes("选题") ||
      bodyText.includes("试题");

    return isQuestionSearchPage() ||
      getQuestionBlocks().length > 0 ||
      findSelectableCheckboxes().length > 0 ||
      (hasQuestionHints && findActionButtons().length > 0);
  }

  function findSelectableCheckboxes() {
    return Array.from(
      document.querySelectorAll('input[type="checkbox"], [role="checkbox"], .el-checkbox')
    ).filter((node) => {
      if (!isVisible(node)) {
        return false;
      }

      if (node instanceof HTMLInputElement) {
        if (node.disabled || node.checked) {
          return false;
        }

        const text = normalizeText(node.closest("label, li, tr, div")?.innerText || "");
        return text.includes("题") || text.includes("选题") || text.includes("试题");
      }

      const ariaChecked = node.getAttribute("aria-checked");
      if (ariaChecked === "true") {
        return false;
      }

      const text = normalizeText(node.closest("label, li, tr, div")?.innerText || "");
      return text.includes("题") || text.includes("选题") || text.includes("试题");
    });
  }

  function findSelectableControlsInBlock(block) {
    const controls = [];

    const explicitAddButtons = Array.from(
      block.querySelectorAll("a.add, .btn.add, a.btn-orange.btn-xs.add, a.btn.add")
    ).filter((node) => {
      if (!isVisible(node) || shouldSkipActionNode(node)) {
        return false;
      }

      const signature = getNodeSignature(node);
      return signature.includes("试题篮") || signature.includes("加入试题篮");
    });

    controls.push(...explicitAddButtons);

    const checkboxCandidates = Array.from(
      block.querySelectorAll('input[type="checkbox"], [role="checkbox"], .el-checkbox')
    ).filter(isVisible);

    for (const node of checkboxCandidates) {
      if (node instanceof HTMLInputElement && (node.disabled || node.checked)) {
        continue;
      }

      const text = normalizeText(node.closest("label, li, tr, div, td")?.textContent || block.textContent || "");
      if (text.includes("题") || text.includes("选题") || text.includes("试题")) {
        controls.push(node);
      }
    }

    const actionCandidates = Array.from(
      block.querySelectorAll("button, a, span, div, li, i")
    ).filter((node) => {
      if (!isVisible(node) || shouldSkipActionNode(node)) {
        return false;
      }

      const signature = getNodeSignature(node);
      return isTargetText(signature) || /add|paper|basket|cart|select|choose|join|insert|put/i.test(signature);
    });

    controls.push(...actionCandidates);
    return controls;
  }

  function isTargetText(text) {
    return TARGET_TEXTS.some((keyword) => text.includes(keyword)) &&
      !EXCLUDED_TEXTS.some((keyword) => text.includes(keyword));
  }

  function findActionButtons() {
    return Array.from(
      document.querySelectorAll("a.add, .btn.add, a.btn-orange.btn-xs.add, a.btn.add, button, a, span, div, li")
    ).filter((node) => {
      if (!isVisible(node) || shouldSkipActionNode(node)) {
        return false;
      }

      const signature = getNodeSignature(node);
      if (!signature || signature.length > 120) {
        return false;
      }

      const interactive =
        node instanceof HTMLButtonElement ||
        node instanceof HTMLAnchorElement ||
        node.getAttribute("role") === "button" ||
        typeof node.onclick === "function" ||
        node.className.toString().includes("btn");

      return interactive && (isTargetText(signature) || /add|paper|basket|cart|select|choose|join|insert|put/i.test(signature));
    });
  }

  function triggerCheckbox(node) {
    if (node instanceof HTMLInputElement) {
      node.click();
      return true;
    }

    if (node instanceof HTMLElement) {
      node.click();
      return true;
    }

    return false;
  }

  function triggerAction(node) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }

    if (shouldSkipActionNode(node)) {
      return false;
    }

    const signature = getNodeSignature(node);
    if (!(isTargetText(signature) || /add|paper|basket|cart|select|choose|join|insert|put/i.test(signature))) {
      return false;
    }

    const target = node.closest("a.add, .btn.add, button, a, label, li, div") || node;
    ["pointerdown", "mousedown", "mouseup", "click"].forEach((type) => {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });
    return true;
  }

  function fireAction(node, attemptedCountRef) {
    let clickedNow = false;
    if (node instanceof HTMLInputElement) {
      if (clickOnceFactory(attemptedCountRef)(node)) {
        clickedNow = true;
      }
      return clickedNow;
    }

    clickedNow = triggerAction(node);
    if (clickedNow) {
      attemptedCountRef.count += 1;
    }
    return clickedNow;
  }

  function clickOnceFactory(attemptedCountRef) {
    return (node) => {
      if (!(node instanceof HTMLElement) && !(node instanceof HTMLInputElement)) {
        return false;
      }
      node.click();
      attemptedCountRef.count += 1;
      return true;
    };
  }

  function setStatus(message) {
    const status = document.getElementById(STATUS_ID);
    if (status) {
      status.textContent = message;
    }
  }

  function getLogTrack() {
    return document.getElementById(LOG_TRACK_ID);
  }

  function ensureLogScroller() {
    const panel = document.getElementById(LOG_ID);
    if (!panel || panel.dataset.scrollerBound === "1") {
      return;
    }

    panel.dataset.scrollerBound = "1";
    let lastTime = 0;

    const tick = (time) => {
      if (!document.getElementById(LOG_ID)) {
        return;
      }

      if (!lastTime) {
        lastTime = time;
      }

      const delta = time - lastTime;
      lastTime = time;

      if (panel.scrollHeight > panel.clientHeight) {
        panel.scrollTop += delta * 0.04;
        if (panel.scrollTop >= panel.scrollHeight - panel.clientHeight - 1) {
          panel.scrollTop = 0;
        }
      }

      window.requestAnimationFrame(tick);
    };

    window.requestAnimationFrame(tick);
  }

  function appendRuntimeLog(message) {
    const track = getLogTrack();
    if (!track) {
      return;
    }

    const line = document.createElement("p");
    line.className = "jyeoo-select-all-log-line";
    line.textContent = message;
    track.appendChild(line);

    while (track.childElementCount > 80) {
      track.removeChild(track.firstElementChild);
    }
  }

  function clearRuntimeLog() {
    const track = getLogTrack();
    if (track) {
      track.innerHTML = "";
    }
  }

  function log(message, extra) {
    appendRuntimeLog(message);
    if (typeof extra === "undefined") {
      console.log(`${LOG_PREFIX} ${message}`);
      return;
    }

    console.log(`${LOG_PREFIX} ${message}`, extra);
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function getBasketCount() {
    const extractSmallNumber = (node) => {
      if (!(node instanceof Element)) {
        return null;
      }

      const text = normalizeText(node.textContent || "");
      if (!/^\d{1,3}$/.test(text)) {
        return null;
      }

      const value = Number(text);
      return Number.isFinite(value) ? value : null;
    };

    const explicitQuestionNum = Array.from(document.querySelectorAll(".question-num"))
      .find((node) => {
        if (!isVisible(node)) {
          return false;
        }

        if (node.closest(`#${ROOT_ID}`)) {
          return false;
        }

        return extractSmallNumber(node) !== null;
      });

    if (explicitQuestionNum) {
      return extractSmallNumber(explicitQuestionNum);
    }

    const basket = findBasketAnchor();
    if (!basket) {
      return null;
    }

    const candidates = Array.from(
      basket.querySelectorAll("em, strong, b, i, span, sup, sub")
    )
      .map((node) => extractSmallNumber(node))
      .filter((value) => value !== null);

    if (candidates.length > 0) {
      return candidates[0];
    }

    return extractSmallNumber(basket);
  }

  function describeNode(node) {
    if (!(node instanceof Element)) {
      return "unknown";
    }

    const signature = getNodeSignature(node).slice(0, 80);
    const tag = node.tagName.toLowerCase();
    const cls = typeof node.className === "string" ? node.className.trim() : "";
    return `${tag}${cls ? "." + cls.replace(/\s+/g, ".") : ""} ${signature}`.trim();
  }

  function findBasketAnchor() {
    const candidates = Array.from(document.querySelectorAll("a, div, span, li, aside"))
      .filter((node) => {
        if (!isVisible(node)) {
          return false;
        }

        if (node.closest(`#${ROOT_ID}`)) {
          return false;
        }

        const text = normalizeText(node.textContent || "");
        return text.includes("试题篮");
      })
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const score =
          (style.position === "fixed" ? 10000 : 0) +
          (style.position === "sticky" ? 5000 : 0) +
          (rect.left >= window.innerWidth * 0.7 ? 3000 : 0) +
          (rect.width <= 180 ? 800 : 0) +
          (rect.height <= 220 ? 400 : 0) -
          rect.width -
          rect.height +
          rect.left;

        return { node, rect, score };
      })
      .sort((a, b) => b.score - a.score);

    return candidates[0]?.node || null;
  }

  function findNextPageLink() {
    return Array.from(document.querySelectorAll("a.next, a[title*='下一页'], a"))
      .find((node) => {
        if (!isVisible(node)) {
          return false;
        }

        const signature = getNodeSignature(node);
        if (!signature.includes("下一页")) {
          return false;
        }

        const cls = typeof node.className === "string" ? node.className : "";
        return !/disabled|off|gray/i.test(cls);
      }) || null;
  }

  function findPagerSelect() {
    const selects = Array.from(document.querySelectorAll(".pagertips select.ml10, .pagertips select, select.ml10, select"));
    log(`分页下拉框候选数量: ${selects.length}`);

    return selects.find((node) => {
      if (!(node instanceof HTMLSelectElement) || !isVisible(node)) {
        return false;
      }

      const optionValues = Array.from(node.options).map((option) => (option.value || "").trim());
      const hasGoPage = /goPage/i.test(node.getAttribute("onchange") || "");
      const looksLikePager = optionValues.some((value) => /^\d+$/.test(value));
      if (looksLikePager) {
        log(`命中分页下拉框，当前值: ${node.value}`, {
          optionValues,
          hasGoPage,
          className: node.className
        });
      }

      return looksLikePager && hasGoPage;
    }) || null;
  }

  function goToNextPage(nextPageLink) {
    if (!(nextPageLink instanceof HTMLElement)) {
      return false;
    }

    const href = nextPageLink.getAttribute("href") || "";
    const signature = getNodeSignature(nextPageLink);
    log(`准备翻页: ${signature || "下一页"}`);

    const pagerSelect = findPagerSelect();
    if (pagerSelect instanceof HTMLSelectElement) {
      const currentValue = Number(pagerSelect.value || pagerSelect.options[pagerSelect.selectedIndex]?.value || "");
      const nextValue = Number.isFinite(currentValue) ? currentValue + 1 : NaN;
      const nextOption = Array.from(pagerSelect.options).find((option) => Number(option.value) === nextValue);
      log("分页下拉框状态", {
        currentValue,
        nextValue,
        selectedIndex: pagerSelect.selectedIndex
      });
      if (nextOption) {
        try {
          pagerSelect.value = nextOption.value;
          const onchangeCode = pagerSelect.getAttribute("onchange") || "";

          if (/goPage/i.test(onchangeCode) && typeof window.goPage === "function") {
            window.goPage(String(nextOption.value), pagerSelect);
          } else if (typeof pagerSelect.onchange === "function") {
            pagerSelect.onchange.call(pagerSelect);
          } else {
            pagerSelect.dispatchEvent(new Event("change", { bubbles: true }));
          }
          log(`已通过分页下拉框跳转到第 ${nextOption.value} 页`);
          return true;
        } catch (error) {
          log("分页下拉框翻页失败", error);
        }
      } else {
        log("分页下拉框未找到下一页 option");
      }
    } else {
      log("未找到可用的分页下拉框");
    }

    const goPageMatch = href.match(/goPage\((\d+),this\)/i);
    if (goPageMatch && typeof window.goPage === "function") {
      const pageNo = Number(goPageMatch[1]);
      if (Number.isFinite(pageNo)) {
        try {
          window.goPage(String(pageNo), nextPageLink);
          return true;
        } catch (error) {
          log("直接调用 goPage(string) 失败", error);
        }

        try {
          window.goPage(pageNo, nextPageLink);
          return true;
        } catch (error) {
          log("直接调用 goPage(number) 失败", error);
        }
      }
    }

    try {
      nextPageLink.click();
      return true;
    } catch (error) {
      log("原生 click 翻页失败", error);
    }

    if (/^javascript:/i.test(href)) {
      const code = href.replace(/^javascript:/i, "").trim();
      if (code) {
        try {
          window.eval(code);
          return true;
        } catch (error) {
          log("执行 href 翻页脚本失败", error);
        }
      }
    }

    ["pointerdown", "mousedown", "mouseup", "click"].forEach((type) => {
      nextPageLink.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });

    return true;
  }

  function positionWidget() {
    const root = document.getElementById(ROOT_ID);
    if (!root) {
      return;
    }

    const prefs = loadPanelPrefs();
    if (typeof prefs.top === "number" && typeof prefs.right === "number") {
      root.style.top = `${prefs.top}px`;
      root.style.right = `${prefs.right}px`;
      root.style.bottom = "auto";
      return;
    }

    const basket = findBasketAnchor();
    if (!basket) {
      root.style.right = "108px";
      root.style.top = "220px";
      root.style.bottom = "auto";
      return;
    }

    const rect = basket.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const desiredTop = rect.top + rect.height / 2 - 22;
    const maxTop = Math.max(16, window.innerHeight - rootRect.height - 16);
    const top = Math.min(maxTop, Math.max(16, desiredTop));
    const right = Math.max(16, window.innerWidth - rect.left + 12);

    root.style.top = `${Math.round(top)}px`;
    root.style.right = `${Math.round(right)}px`;
    root.style.bottom = "auto";
  }

  function startDrag(event) {
    const root = document.getElementById(ROOT_ID);
    if (!root) {
      return;
    }

    const target = event.target;
    if (target instanceof HTMLElement && target.closest(`#${TOGGLE_BUTTON_ID}`)) {
      return;
    }

    const rect = root.getBoundingClientRect();
    dragState = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    };
    root.classList.add("dragging");
    event.preventDefault();
  }

  function handleDrag(event) {
    const root = document.getElementById(ROOT_ID);
    if (!root || !dragState) {
      return;
    }

    const maxLeft = Math.max(0, window.innerWidth - root.offsetWidth - 12);
    const maxTop = Math.max(0, window.innerHeight - root.offsetHeight - 12);
    const left = Math.min(maxLeft, Math.max(12, event.clientX - dragState.offsetX));
    const top = Math.min(maxTop, Math.max(12, event.clientY - dragState.offsetY));
    const right = Math.max(12, window.innerWidth - left - root.offsetWidth);

    root.style.top = `${Math.round(top)}px`;
    root.style.right = `${Math.round(right)}px`;
    root.style.bottom = "auto";
  }

  function endDrag() {
    const root = document.getElementById(ROOT_ID);
    if (!root || !dragState) {
      dragState = null;
      return;
    }

    root.classList.remove("dragging");
    const top = Number.parseFloat(root.style.top || "0");
    const right = Number.parseFloat(root.style.right || "0");
    savePanelPrefs({ top, right });
    dragState = null;
  }

  function togglePanelCollapsed() {
    const prefs = loadPanelPrefs();
    const collapsed = !prefs.collapsed;
    savePanelPrefs({ collapsed });
    applyPanelPrefs();
  }

  async function runSelectAll(options = {}) {
    const multiPage = Boolean(options.multiPage);
    const resumed = Boolean(options.resumed);
    const targetCount = options.targetCount || MULTI_PAGE_TARGET_COUNT;

    if (isRunning) {
      log("已有任务在执行，忽略新的请求");
      return;
    }

    isRunning = true;
    clearRuntimeLog();
    setStatus(multiPage ? "多页处理中..." : "处理中...");
    log(multiPage ? (resumed ? "恢复多页选题任务" : "开始多页选题任务") : "开始批量加入试题篮", {
      url: window.location.href,
      basketCountBefore: getBasketCount()
    });

    const attemptedCountRef = { count: 0 };
    let successfulCount = 0;
    const clickOnce = clickOnceFactory(attemptedCountRef);

    const collectTargets = () => {
      const blocks = getQuestionBlocks();
      const targets = [];

      const explicitPageButtons = Array.from(
        document.querySelectorAll("a.add, .btn.add, a.btn-orange.btn-xs.add, a.btn.add")
      ).filter((node) => {
        if (!isVisible(node) || shouldSkipActionNode(node)) {
          return false;
        }

        const signature = getNodeSignature(node);
        return signature.includes("试题篮") || signature.includes("加入试题篮");
      });

      for (const button of explicitPageButtons) {
        if (!targets.includes(button)) {
          targets.push(button);
        }
      }

      for (const block of blocks) {
        const controls = findSelectableControlsInBlock(block);
        const target = controls.find((node) => {
          const signature = getNodeSignature(node);
          return isTargetText(signature) || /add|paper|basket|cart|select|choose|join|insert|put/i.test(signature);
        });

        if (target) {
          if (!targets.includes(target)) {
            targets.push(target);
          }
          continue;
        }

        const checkbox = controls.find((node) => {
          if (node instanceof HTMLInputElement) {
            return !node.checked && !node.disabled;
          }

          return true;
        });

        if (checkbox) {
          if (!targets.includes(checkbox)) {
            targets.push(checkbox);
          }
        }
      }

      if (blocks.length === 0) {
        for (const checkbox of findSelectableCheckboxes()) {
          if (!targets.includes(checkbox)) {
            targets.push(checkbox);
          }
        }

        for (const action of findActionButtons()) {
          if (!targets.includes(action)) {
            targets.push(action);
          }
        }
      }

      return targets.reverse();
    };

    const collectTargetsWithWait = async (reasonLabel) => {
      let targets = collectTargets();
      if (targets.length > 0 || !multiPage) {
        return targets;
      }

      for (let attempt = 1; attempt <= PAGE_READY_RETRY_COUNT; attempt += 1) {
        log(`${reasonLabel}当前未找到题目，等待页面加载 (${attempt}/${PAGE_READY_RETRY_COUNT})`);
        await sleep(PAGE_READY_RETRY_DELAY_MS);
        targets = collectTargets();
        if (targets.length > 0) {
          log(`${reasonLabel}等待后检测到 ${targets.length} 个待处理控件`);
          return targets;
        }
      }

      return targets;
    };

    const waitForNextPageLink = async () => {
      let nextPageLink = findNextPageLink();
      if (nextPageLink) {
        return nextPageLink;
      }

      for (let attempt = 1; attempt <= PAGE_READY_RETRY_COUNT; attempt += 1) {
        log(`当前未找到下一页入口，等待分页控件加载 (${attempt}/${PAGE_READY_RETRY_COUNT})`);
        await sleep(PAGE_READY_RETRY_DELAY_MS);
        nextPageLink = findNextPageLink();
        if (nextPageLink) {
          return nextPageLink;
        }
      }

      return null;
    };

    const processPass = async (targets, passLabel) => {
      if (targets.length === 0) {
        log(`${passLabel}未检测到待处理控件`);
        return 0;
      }

      log(`${passLabel}检测到 ${targets.length} 个待处理控件`);
      let passSuccessCount = 0;

      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index];
        const basketBefore = getBasketCount();
        const description = describeNode(target);

        setStatus(`${passLabel} ${index + 1}/${targets.length}`);
        log(`${passLabel}准备点击 ${index + 1}/${targets.length}: ${description}`);

        let clickedNow = false;
        if (target instanceof HTMLInputElement) {
          clickedNow = clickOnce(target);
        } else {
          clickedNow = fireAction(target, attemptedCountRef);
        }

        await sleep(CLICK_DELAY_MS);

        const basketAfter = getBasketCount();
        const likelySuccess =
          basketBefore !== null &&
          basketAfter !== null &&
          basketAfter > basketBefore;

        if (likelySuccess) {
          passSuccessCount += 1;
        }

        log(`${passLabel}点击结果 ${index + 1}/${targets.length}`, {
          clicked: clickedNow,
          basketBefore,
          basketAfter,
          likelySuccess
        });
      }

      return passSuccessCount;
    };

    const firstPassTargets = await collectTargetsWithWait("第一轮");
    try {
      if (firstPassTargets.length === 0) {
        setStatus("当前页面未找到可操作的选题控件");
        if (!multiPage) {
          return;
        }
      } else {
        successfulCount += await processPass(firstPassTargets, "第一轮");
        setStatus("等待页面同步...");
        log(`第一轮结束，等待 ${PASS_GAP_MS}ms 后开始复查`);
        await sleep(PASS_GAP_MS);

        const secondPassTargets = await collectTargetsWithWait("第二轮");
        successfulCount += await processPass(secondPassTargets, "第二轮");
      }

      const basketAfterAll = getBasketCount();

      if (multiPage) {
        log(`多页模式本轮结束，读取题篮数量: ${basketAfterAll}`);

        if (basketAfterAll === null) {
          clearMultiPageState();
          setStatus("无法读取题篮数量，已停止多页模式");
          log("无法读取题篮数量，停止多页模式");
          return;
        }

        if (basketAfterAll >= targetCount) {
          clearMultiPageState();
          setStatus(`已达到 ${basketAfterAll} 题，停止多页模式`);
          log(`多页任务完成，题篮已达到 ${basketAfterAll} 题`);
          return;
        }

        const nextPageLink = await waitForNextPageLink();
        if (!nextPageLink) {
          clearMultiPageState();
          setStatus(`未找到下一页，当前题篮 ${basketAfterAll}`);
          log(`未找到下一页链接，停止多页模式，当前题篮 ${basketAfterAll}`);
          return;
        }

        saveMultiPageState({
          active: true,
          targetCount,
          updatedAt: Date.now(),
          fromUrl: window.location.href
        });
        setStatus(`题篮 ${basketAfterAll}/${targetCount}，前往下一页...`);
        log(`题篮 ${basketAfterAll}/${targetCount}，即将进入下一页继续选题`);
        await sleep(1200);
        goToNextPage(nextPageLink);
        return;
      }

      setStatus(
        `已尝试 ${attemptedCountRef.count} 次，疑似成功 ${successfulCount} 个` +
        (basketAfterAll !== null ? `，题篮 ${basketAfterAll}` : "")
      );
      log("批量处理结束", {
        attemptedCount: attemptedCountRef.count,
        successfulCount,
        basketAfterAll
      });
    } finally {
      isRunning = false;
    }
  }

  function createWidget() {
    if (document.getElementById(ROOT_ID)) {
      return;
    }

    const root = document.createElement("div");
    root.id = ROOT_ID;

    const toolbar = document.createElement("div");
    toolbar.id = TOOLBAR_ID;

    const toolbarTitle = document.createElement("div");
    toolbarTitle.id = TOOLBAR_TITLE_ID;
    toolbarTitle.textContent = "组卷助手";

    const toolbarActions = document.createElement("div");
    toolbarActions.id = TOOLBAR_ACTIONS_ID;

    const toggleButton = document.createElement("button");
    toggleButton.id = TOGGLE_BUTTON_ID;
    toggleButton.className = "jyeoo-select-all-toolbtn";
    toggleButton.type = "button";
    toggleButton.textContent = "−";
    toggleButton.title = "隐藏";
    toggleButton.addEventListener("click", (event) => {
      event.stopPropagation();
      togglePanelCollapsed();
    });

    toolbarActions.appendChild(toggleButton);
    toolbar.appendChild(toolbarTitle);
    toolbar.appendChild(toolbarActions);
    toolbar.addEventListener("pointerdown", startDrag);

    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.textContent = BUTTON_TEXT;
    button.addEventListener("click", () => {
      clearMultiPageState();
      void runSelectAll();
    });

    const multiButton = document.createElement("button");
    multiButton.id = MULTI_BUTTON_ID;
    multiButton.type = "button";
    multiButton.textContent = MULTI_BUTTON_TEXT;
    multiButton.addEventListener("click", () => {
      saveMultiPageState({
        active: true,
        targetCount: MULTI_PAGE_TARGET_COUNT,
        updatedAt: Date.now(),
        fromUrl: window.location.href
      });
      void runSelectAll({ multiPage: true, targetCount: MULTI_PAGE_TARGET_COUNT });
    });

    const status = document.createElement("div");
    status.id = STATUS_ID;
    status.textContent = "等待检测题目";

    const logPanel = document.createElement("div");
    logPanel.id = LOG_ID;

    const logTrack = document.createElement("div");
    logTrack.id = LOG_TRACK_ID;
    logPanel.appendChild(logTrack);

    root.appendChild(toolbar);
    root.appendChild(button);
    root.appendChild(multiButton);
    root.appendChild(status);
    root.appendChild(logPanel);
    (document.body || document.documentElement).appendChild(root);
    ensureLogScroller();
    applyPanelPrefs();
    positionWidget();
  }

  function syncWidget() {
    const root = document.getElementById(ROOT_ID);
    const shouldShow = shouldShowButton();

    if (shouldShow && !root) {
      createWidget();
      return;
    }

    if (!shouldShow && root) {
      root.remove();
      return;
    }

    if (shouldShow) {
      const blockCount = getQuestionBlocks().length;
      setStatus(blockCount > 0 ? `已就绪，检测到 ${blockCount} 个题块` : "已就绪");
      positionWidget();
    }
  }

  function ensureWidgetPresent() {
    if (isQuestionSearchPage()) {
      if (!document.getElementById(ROOT_ID)) {
        createWidget();
      }

      positionWidget();
      const blockCount = getQuestionBlocks().length;
      setStatus(blockCount > 0 ? `已就绪，检测到 ${blockCount} 个题块` : "已就绪");
      scheduleMultiPageResume(1200);
      return;
    }

    syncWidget();
  }

  const observer = new MutationObserver(() => {
    window.clearTimeout(syncWidget._timer);
    syncWidget._timer = window.setTimeout(ensureWidgetPresent, 300);
  });

  function init() {
    ensureWidgetPresent();
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
    window.addEventListener("scroll", positionWidget, { passive: true });
    window.addEventListener("resize", positionWidget);
    window.addEventListener("pageshow", ensureWidgetPresent);
    window.addEventListener("load", ensureWidgetPresent);
    window.addEventListener("popstate", ensureWidgetPresent);
    window.addEventListener("pointermove", handleDrag, { passive: true });
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    window.setInterval(ensureWidgetPresent, 1500);
    scheduleMultiPageResume(1800);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
