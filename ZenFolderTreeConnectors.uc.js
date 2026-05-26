// ==UserScript==
// @name         Zen Folder Tree Connectors
// @description  Draws tree connectors for Zen Browser folders
// @version      2.0
// @author       JustAdumbPrsn
// @grant        none
// ==/UserScript==

(function () {

  const SVG_NS = "http://www.w3.org/2000/svg";
  const PREF_OWNED_TABS = "zen.folders.owned-tabs-in-folder";
  const PREF_WORKSPACE_ANIM = "zen.workspaces.switch-animation-duration";

  const GEO = Object.freeze({
    LINE_X: 6,
    STROKE_WIDTH: 2,
    BRANCH_RADIUS: 7,
    OPACITY: 0.25,
  });

  const LINEAGE_EVENTS = new Set([
    "TabGrouped", "TabUngrouped", "FolderGrouped", "FolderUngrouped",
    "TabMove", "TabOpen", "TabClose", "TabGroupCreate", "TabGroupRemoved",
  ]);

  const REPAINT_EVENTS = new Set([
    "TabSelect", "TabPinned", "TabUnpinned", "ZenFolderRenamed",
    "ZenFolderChangedWorkspace", "TabAddedToEssentials", "TabRemovedFromEssentials",
    "ZenTabRemovedFromSplit", "ZenTabIconChanged", "ZenTabLabelChanged",
  ]);

  const ANIMATED_EVENTS = new Set([
    "TabGroupExpand", "TabGroupCollapse", "ZenSplitViewTabsSplit",
    "ZenWorkspacesUIUpdate", "ZenWorkspaceDataChanged",
  ]);

  const DND_EVENTS = new Set([
    "dragstart", "dragover", "dragend", "drop",
  ]);

  const DND_ANIMATED_EVENTS = new Set([
    "dragstart", "dragover",
  ]);

  class nsZenFolderTreeConnectors {
    #initialized = false;
    #needsCleanUp = true;
    #relationshipClassesDirty = true;
    #resizeTargetsDirty = true;

    #rafId = null;
    #isAnimating = false;
    #animationTimeout = null;
    #animationEndTime = 0;

    #resizeObserver = null;
    #mutationObserver = null;
    #attrObserver = null;

    #observedElements = new Set();
    #lastPaths = new WeakMap();
    #connectors = new WeakMap();

    #activeChildren = new Set();
    #activeParents = new Set();
    #lineageMap = new Map();

    #pendingWrites = [];

    QueryInterface = ChromeUtils.generateQI(["nsIObserver"]);

    init() {
      if (this.#initialized) return;

      this.#resizeObserver = new ResizeObserver(() => this.scheduleUpdate(true, 150));

      this.#mutationObserver = new MutationObserver(aMutations => {
        let needsLineageUpdate = false;
        for (const m of aMutations) {
          if (m.type === "childList") {
            needsLineageUpdate = true;
            break;
          }
        }
        if (needsLineageUpdate) {
          this.#relationshipClassesDirty = true;
          this.#resizeTargetsDirty = true;
        }
        this.scheduleUpdate(true, 150);
      });

      this.#attrObserver = new MutationObserver(aMutations => {
        let isWorkspaceSwitch = false;
        for (const m of aMutations) {
          if (m.attributeName === "active" || m.attributeName === "collapsedpinnedtabs") {
            isWorkspaceSwitch = true;
            break;
          }
        }
        this.#relationshipClassesDirty = true;
        this.#resizeTargetsDirty = true;
        const duration = isWorkspaceSwitch
          ? Services.prefs.getIntPref(PREF_WORKSPACE_ANIM, 250) + 20
          : 150;
        this.scheduleUpdate(true, duration);
      });

      this.#bindEventListeners();
      this.#bindPrefObserver();

      this.#initialized = true;
      this.#relationshipClassesDirty = true;
      this.#resizeTargetsDirty = true;
      this.#needsCleanUp = true;
      this.scheduleUpdate(true, 150);
    }

    uninit() {
      if (!this.#initialized) return;

      this.#stopAnimation();
      this.#resizeObserver?.disconnect();
      this.#resizeObserver = null;
      this.#mutationObserver?.disconnect();
      this.#mutationObserver = null;
      this.#attrObserver?.disconnect();
      this.#attrObserver = null;
      this.#unbindEventListeners();

      try {
        Services.prefs.removeObserver(PREF_OWNED_TABS, this);
      } catch {}

      this.#removeAllRelationshipClasses();

      for (const el of document.querySelectorAll(".tree-connector")) {
        el.remove();
      }

      this.#observedElements = new Set();
      this.#lastPaths = new WeakMap();
      this.#connectors = new WeakMap();
      this.#lineageMap.clear();
      this.#pendingWrites.length = 0;

      this.#relationshipClassesDirty = true;
      this.#resizeTargetsDirty = true;
      this.#needsCleanUp = true;
      this.#initialized = false;
    }

    /**
     * Schedules a repaint of all tree connectors.
     *
     * @param {boolean} aIsContinuous - If true, drives a rAF loop for the given duration.
     * @param {number} aDuration - How long in ms to keep repainting, used for animations.
     */
    scheduleUpdate(aIsContinuous = false, aDuration = 0) {
      if (aDuration > 0) {
        this.#animationEndTime = Math.max(this.#animationEndTime, Date.now() + aDuration);
      }
      if (aIsContinuous || Date.now() < this.#animationEndTime) {
        this.#startAnimation();
      } else {
        this.#scheduleSingleFrame();
      }
    }

    #scheduleSingleFrame() {
      if (this.#isAnimating || this.#rafId !== null) return;
      this.#rafId = requestAnimationFrame(() => {
        this.#rafId = null;
        this.#repaint();
      });
    }

    #startAnimation() {
      if (this.#isAnimating) {
        if (this.#animationTimeout) clearTimeout(this.#animationTimeout);
        const delay = Math.max(50, this.#animationEndTime - Date.now());
        this.#animationTimeout = setTimeout(() => this.#stopAnimation(), delay);
        return;
      }

      this.#isAnimating = true;
      if (this.#rafId !== null) cancelAnimationFrame(this.#rafId);

      const loop = () => {
        if (!this.#isAnimating) return;
        this.#repaint();
        if (Date.now() < this.#animationEndTime) {
          this.#rafId = requestAnimationFrame(loop);
        } else {
          this.#stopAnimation();
        }
      };
      this.#rafId = requestAnimationFrame(loop);

      const delay = Math.max(50, this.#animationEndTime - Date.now());
      this.#animationTimeout = setTimeout(() => this.#stopAnimation(), delay);
    }

    #stopAnimation() {
      this.#isAnimating = false;
      if (this.#rafId !== null) {
        cancelAnimationFrame(this.#rafId);
        this.#rafId = null;
      }
      if (this.#animationTimeout) {
        clearTimeout(this.#animationTimeout);
        this.#animationTimeout = null;
      }
      this.#scheduleSingleFrame();
    }

    get #ownedTabsInFolder() {
      return Services.prefs.getBoolPref(PREF_OWNED_TABS, false);
    }

    #getBoundsWithoutFlushing(aElement) {
      if (!aElement) return null;
      try {
        return window.windowUtils.getBoundsWithoutFlushing(aElement);
      } catch (e) {
        console.warn("nsZenFolderTreeConnectors: getBoundsWithoutFlushing failed", e);
        return null;
      }
    }

    #repaint() {
      if (!window.gBrowser) return;

      const sidebarExpanded =
        document.documentElement.getAttribute("zen-sidebar-expanded") === "true";

      if (!sidebarExpanded) {
        if (this.#needsCleanUp) {
          this.#removeAllRelationshipClasses();
          for (const el of document.querySelectorAll(".tree-connector")) {
            el.hidden = true;
          }
          this.#lastPaths = new WeakMap();
          this.#needsCleanUp = false;
        }
        return;
      }
      this.#needsCleanUp = true;

      if (this.#relationshipClassesDirty) {
        this.#updateRelationshipClasses();
        this.#relationshipClassesDirty = false;
      }

      if (this.#resizeTargetsDirty) {
        this.#ensureResizeTargetsObserved();
      }

      const activeWorkspaceId = window.gZenWorkspaces?.activeWorkspace;
      if (!activeWorkspaceId) return;

      const isRTL = document.documentElement.matches(":-moz-locale-dir(rtl)");

      this.#pendingWrites.length = 0;
      const rootActiveTabsCache = new Map();

      for (const folder of window.gBrowser.tabGroups) {
        if (!folder.isZenFolder) continue;

        // Skip visual lines for the internal Zen Collapsible Pins module.
        if (folder.tagName.toLowerCase() === "zen-workspace-collapsible-pins") continue;

        const container =
          folder.groupContainer || folder.querySelector(":scope > .tab-group-container");
        if (!container) continue;

        if (this.#isFolderHidden(folder, activeWorkspaceId)) {
          this.#pendingWrites.push({ host: container, hide: true });
          continue;
        }

        const visibleChildren = this.#collectVisibleChildren(folder);
        if (visibleChildren.length === 0) {
          this.#pendingWrites.push({ host: container, hide: true });
        } else {
          this.#pendingWrites.push({
            host: container,
            pathData: this.#buildPath(container, visibleChildren, false, null, isRTL),
          });
        }
      }

      for (const [parentTab, children] of this.#lineageMap.entries()) {
        if (parentTab.hidden || parentTab.hasAttribute("zen-empty-tab")) {
          this.#pendingWrites.push({ host: parentTab, hide: true });
          continue;
        }

        const folder = this.#getTabFolder(parentTab);
        if (folder) {
          const rootMost = folder.rootMostCollapsedFolder;
          if (rootMost) {
            let activeSet = rootActiveTabsCache.get(rootMost);
            if (!activeSet) {
              activeSet = new Set(rootMost.activeTabs ?? []);
              rootActiveTabsCache.set(rootMost, activeSet);
            }
            if (!activeSet.has(parentTab)) {
              this.#pendingWrites.push({ host: parentTab, hide: true });
              continue;
            }
          }
        }

        if (children.length === 0) {
          this.#pendingWrites.push({ host: parentTab, hide: true });
        } else {
          this.#pendingWrites.push({
            host: parentTab,
            pathData: this.#buildPath(
              parentTab,
              children,
              true,
              this.#getBoundsWithoutFlushing(parentTab),
              isRTL
            ),
            isRelated: true,
          });
        }
      }

      for (let i = 0; i < this.#pendingWrites.length; i++) {
        const entry = this.#pendingWrites[i];
        if (entry.hide) {
          this.#hideConnector(entry.host);
        } else {
          this.#applyConnector(entry.host, entry.pathData, entry.isRelated || false);
        }
      }
    }

    #isFolderHidden(aFolder, aActiveWorkspaceId) {
      const isSwitching = window.gZenWorkspaces?.isChangingWorkspace;
      if (!isSwitching && aFolder.getAttribute("zen-workspace-id") !== aActiveWorkspaceId) {
        return true;
      }

      const rootMost = aFolder.rootMostCollapsedFolder;
      if (rootMost && rootMost !== aFolder) return true;

      const isPinned = aFolder.pinned || aFolder.hasAttribute("pinned");
      if (isPinned && window.gZenWorkspaces?.activeWorkspaceElement?.hasCollapsedPinnedTabs) {
        return true;
      }

      return false;
    }

    #collectVisibleChildren(aFolder) {
      if (aFolder.collapsed) {
        const activeNodes = new Set();
        for (const tab of aFolder.activeTabs || []) {
          if (tab.hidden || tab.hasAttribute("zen-empty-tab")) continue;
          if (tab.group?.hasAttribute("split-view-group")) {
            activeNodes.add(tab.group);
          } else {
            activeNodes.add(tab);
          }
        }
        return Array.from(activeNodes);
      }

      const result = [];
      for (const item of aFolder.allItems || []) {
        if (window.gBrowser.isTab?.(item)) {
          if (!item.hidden && !item.hasAttribute("zen-empty-tab")) result.push(item);
        } else if (window.gBrowser.isTabGroup?.(item)) {
          if (item.hasAttribute("split-view-group")) {
            const hasVisible = (item.tabs || []).some(
              t => !t.hidden && !t.hasAttribute("zen-empty-tab")
            );
            if (hasVisible) result.push(item);
          } else if (item.isZenFolder) {
            result.push(item);
          }
        }
      }
      return result;
    }

    #buildPath(aHost, aTargets, aIsRelated, aContextRect, aIsRTL) {
      const { LINE_X, BRANCH_RADIUS } = GEO;

      const hostRect = this.#getBoundsWithoutFlushing(aHost);
      if (!hostRect || hostRect.width === 0) return "";

      const points = [];

      for (const target of aTargets) {
        const measuredEl = aIsRelated
          ? (target.querySelector(".tab-stack") ?? target)
          : target;

        const targetRect = this.#getBoundsWithoutFlushing(measuredEl);
        if (!targetRect || targetRect.width === 0) continue;

        const x = aIsRTL
          ? hostRect.right - targetRect.right
          : targetRect.left - hostRect.left;

        const branchMidY = this.#branchMidY(target, targetRect, aIsRelated);
        const y = targetRect.top - hostRect.top + branchMidY;

        if (y <= 1) continue;

        points.push({ x, y, r: Math.min(BRANCH_RADIUS, Math.max(0, x - LINE_X)) });
      }

      if (points.length === 0) return "";

      points.sort((a, b) => a.y - b.y);

      const last = points[points.length - 1];
      const trunkEndY = last.y - last.r;
      if (trunkEndY < 0) return "";

      const trunkStartY = aContextRect ? aContextRect.height / 2 : 0;

      let d = `M ${LINE_X} ${trunkStartY} L ${LINE_X} ${trunkEndY}`;
      for (const { x, y, r } of points) {
        d += ` M ${LINE_X} ${y - r} A ${r} ${r} 0 0 0 ${LINE_X + r} ${y} L ${x} ${y}`;
      }

      return d;
    }

    #branchMidY(aItem, aTargetRect, aIsRelated) {
      if (aIsRelated) return aTargetRect.height / 2;

      if (aItem.isZenFolder) {
        const label =
          aItem.labelElement?.parentElement ||
          aItem.querySelector(":scope > .tab-group-label-container");
        if (label) {
          const labelRect = this.#getBoundsWithoutFlushing(label);
          return labelRect ? labelRect.height / 2 : 0;
        }
        return 0;
      }

      if (window.gBrowser.isTabGroup?.(aItem)) {
        const firstTab = aItem.tabs?.[0];
        if (firstTab) {
          const tabRect = this.#getBoundsWithoutFlushing(firstTab);
          return tabRect
            ? tabRect.top - aTargetRect.top + tabRect.height / 2
            : aTargetRect.height / 2;
        }
      }

      return aTargetRect.height / 2;
    }

    #applyConnector(aHost, aPathData, aIsRelated) {
      if (!aPathData) {
        this.#hideConnector(aHost);
        return;
      }

      if (this.#lastPaths.get(aHost) === aPathData) return;
      this.#lastPaths.set(aHost, aPathData);

      let connector = this.#connectors.get(aHost);
      if (!connector) {
        connector = document.createElement("div");
        connector.className = aIsRelated
          ? "tree-connector related-connector"
          : "tree-connector";
        if (aIsRelated) {
          aHost.append(connector);
        } else {
          aHost.prepend(connector);
        }
        this.#connectors.set(aHost, connector);
      }

      connector.hidden = false;

      let svg = connector.querySelector("svg");
      if (!svg) {
        svg = this.#createConnectorSVG();
        connector.replaceChildren(svg);
      }

      const path = svg.querySelector("path");
      if (path && path.getAttribute("d") !== aPathData) {
        path.setAttribute("d", aPathData);
      }
    }

    #hideConnector(aHost) {
      const lastPath = this.#lastPaths.get(aHost);
      if (lastPath === null || lastPath === undefined) return;
      this.#lastPaths.set(aHost, null);

      const connector = this.#connectors.get(aHost);
      if (connector) connector.hidden = true;
    }

    #createConnectorSVG() {
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      svg.style.cssText =
        "position:absolute;top:0;inset-inline-start:0;overflow:visible;pointer-events:none;";

      const g = document.createElementNS(SVG_NS, "g");
      g.style.opacity = GEO.OPACITY;
      g.style.stroke = "currentColor";
      g.style.strokeWidth = `${GEO.STROKE_WIDTH}px`;
      g.style.fill = "none";
      g.style.strokeLinecap = "round";

      g.appendChild(document.createElementNS(SVG_NS, "path"));
      svg.appendChild(g);

      return svg;
    }

    #updateRelationshipClasses() {
      if (!window.gBrowser?.tabs) return;

      const isSwitching = window.gZenWorkspaces?.isChangingWorkspace;

      const parentToChildren = this.#ownedTabsInFolder
        ? new Map()
        : this.#computeLineage();

      const newParents = new Set(parentToChildren.keys());
      const newChildren = new Set();
      for (const children of parentToChildren.values()) {
        for (const child of children) newChildren.add(child);
      }

      for (const tab of this.#activeChildren) {
        if (!newChildren.has(tab)) {
          if (isSwitching) {
            newChildren.add(tab);
          } else {
            tab.classList.remove("zen-is-related-child");
          }
        }
      }
      for (const tab of this.#activeParents) {
        if (!newParents.has(tab)) {
          if (isSwitching) {
            newParents.add(tab);
          } else {
            tab.classList.remove("zen-is-related-parent");
            this.#hideRelatedConnector(tab);
          }
        }
      }

      for (const tab of newChildren) {
        if (!this.#activeChildren.has(tab)) tab.classList.add("zen-is-related-child");
      }
      for (const tab of newParents) {
        if (!this.#activeParents.has(tab)) tab.classList.add("zen-is-related-parent");
      }

      this.#activeChildren = newChildren;
      this.#activeParents = newParents;
      this.#lineageMap = parentToChildren;
      this.#resizeTargetsDirty = true;
    }

    /**
     * Returns the innermost zen-folder containing the given tab,
     * accounting for split-view group wrappers.
     *
     * @param {MozTabbrowserTab} aTab
     * @returns {nsZenFolder|null}
     */
    #getTabFolder(aTab) {
      if (!aTab) return null;
      let group = aTab.group;
      if (group?.hasAttribute("split-view-group")) group = group.group;
      return group?.isZenFolder ? group : null;
    }

    #computeLineage() {
      const parentToChildren = new Map();
      const activeWorkspaceId = window.gZenWorkspaces?.activeWorkspace;
      if (!activeWorkspaceId) return parentToChildren;

      let activeParent = null;
      let lineageSet = new Set();

      for (const tab of window.gBrowser.visibleTabs) {
        if (tab.hasAttribute("zen-essential")) continue;

        const folder = this.#getTabFolder(tab);
        if (!folder || tab.classList.contains("zen-tab-group-start")) {
          activeParent = null;
          lineageSet.clear();
          continue;
        }

        const owner = tab.ownerTab;
        const isDescendant =
          owner &&
          activeParent &&
          this.#getTabFolder(owner) === folder &&
          (owner === activeParent || lineageSet.has(owner));

        if (isDescendant) {
          if (!parentToChildren.has(activeParent)) {
            parentToChildren.set(activeParent, []);
          }
          parentToChildren.get(activeParent).push(tab);
          lineageSet.add(tab);
        } else {
          activeParent = tab;
          lineageSet.clear();
          lineageSet.add(tab);
        }
      }

      return parentToChildren;
    }

    #removeAllRelationshipClasses() {
      for (const node of document.querySelectorAll(
        ".zen-is-related-child, .zen-is-related-parent"
      )) {
        node.classList.remove("zen-is-related-child", "zen-is-related-parent");
        this.#hideRelatedConnector(node);
      }
      this.#activeChildren.clear();
      this.#activeParents.clear();
    }

    #hideRelatedConnector(aElement) {
      const connector = aElement.querySelector(
        ":scope > .tree-connector.related-connector"
      );
      if (connector) connector.hidden = true;
    }

    #ensureResizeTargetsObserved() {
      if (!this.#resizeTargetsDirty) return;
      this.#resizeTargetsDirty = false;

      const currentTargets = new Set();

      for (const folder of window.gBrowser.tabGroups) {
        if (
          folder.isZenFolder &&
          folder.tagName.toLowerCase() !== "zen-workspace-collapsible-pins"
        ) {
          const container = folder.groupContainer;
          if (container) currentTargets.add(container);
        }
      }

      for (const el of document.querySelectorAll(
        ".zen-workspace-pinned-tabs-section, .zen-essentials-container"
      )) {
        currentTargets.add(el);
      }

      if (window.gBrowser?.tabContainer) {
        currentTargets.add(window.gBrowser.tabContainer);
      }

      for (const id of ["zen-tabs-wrapper", "tabbrowser-arrowscrollbox"]) {
        const el = document.getElementById(id);
        if (el) currentTargets.add(el);
      }

      for (const tab of this.#activeChildren) currentTargets.add(tab);
      for (const tab of this.#activeParents) currentTargets.add(tab);

      for (const el of this.#observedElements) {
        if (!currentTargets.has(el)) {
          this.#resizeObserver?.unobserve(el);
          this.#observedElements.delete(el);
        }
      }

      for (const el of currentTargets) {
        if (!this.#observedElements.has(el)) {
          this.#resizeObserver?.observe(el);
          this.#observedElements.add(el);
        }
      }
    }

    #bindEventListeners() {
      for (const eventName of LINEAGE_EVENTS) window.addEventListener(eventName, this);
      for (const eventName of REPAINT_EVENTS) window.addEventListener(eventName, this);
      for (const eventName of ANIMATED_EVENTS) window.addEventListener(eventName, this);
      for (const eventName of DND_EVENTS) window.addEventListener(eventName, this);

      this.#mutationObserver?.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["zen-sidebar-expanded"],
      });

      const scrollbox = document.getElementById("tabbrowser-arrowscrollbox");
      if (scrollbox) {
        this.#mutationObserver?.observe(scrollbox, { childList: true });
        this.#attrObserver?.observe(scrollbox, {
          attributes: true,
          attributeFilter: ["active", "collapsedpinnedtabs"],
          subtree: true,
        });
      }
    }

    #unbindEventListeners() {
      for (const eventName of LINEAGE_EVENTS) window.removeEventListener(eventName, this);
      for (const eventName of REPAINT_EVENTS) window.removeEventListener(eventName, this);
      for (const eventName of ANIMATED_EVENTS) window.removeEventListener(eventName, this);
      for (const eventName of DND_EVENTS) window.removeEventListener(eventName, this);
    }

    #bindPrefObserver() {
      try {
        Services.prefs.addObserver(PREF_OWNED_TABS, this);
      } catch (e) {
        console.error("nsZenFolderTreeConnectors: Could not register pref observer.", e);
      }
    }

    observe(aSubject, aTopic, aData) {
      if (aTopic === "nsPref:changed" && aData === PREF_OWNED_TABS) {
        this.#relationshipClassesDirty = true;
        this.scheduleUpdate(false);
      }
    }

    handleEvent(aEvent) {
      const type = aEvent.type;

      if (LINEAGE_EVENTS.has(type)) {
        this.#relationshipClassesDirty = true;
        this.#resizeTargetsDirty = true;
      }

      if (ANIMATED_EVENTS.has(type)) {
        let duration = 120;
        if (type === "ZenWorkspacesUIUpdate" || type === "ZenWorkspaceDataChanged") {
          duration = Services.prefs.getIntPref(PREF_WORKSPACE_ANIM, 250);
        }
        this.scheduleUpdate(true, duration + 20);
      } else if (DND_ANIMATED_EVENTS.has(type)) {
        this.scheduleUpdate(true, 250);
      } else {
        this.scheduleUpdate(false);
      }
    }
  }

  async function bootstrap() {
    if (!window.gBrowser || !window.gZenWorkspaces) {
      document.addEventListener(
        "DOMContentLoaded",
        () => bootstrap().catch(console.error),
        { once: true }
      );
      return;
    }

    if (window.gZenWorkspaces.promiseInitialized) {
      await window.gZenWorkspaces.promiseInitialized;
    }

    window.gZenFolderTreeConnectors?.uninit();
    const instance = new nsZenFolderTreeConnectors();
    window.gZenFolderTreeConnectors = instance;
    instance.init();
  }

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => bootstrap().catch(console.error),
      { once: true }
    );
  } else {
    queueMicrotask(() => bootstrap().catch(console.error));
  }

})();