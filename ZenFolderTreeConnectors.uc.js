// ==UserScript==
// @name         Zen Folder Tree Connectors
// @description  Draws tree connectors for Zen Browser folders
// @version      1.2
// @author       JustAdumbPrsn
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  /* global Services, XPCOMUtils */

  const SVG_NS = "http://www.w3.org/2000/svg";

  class nsZenDOMOperatedFeature {
    constructor() {
      const initBound = this.init.bind(this);
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initBound, {
          once: true,
        });
      } else {
        queueMicrotask(initBound);
      }
    }
  }

  // Events which schedule a connector refresh.
  const SCHEDULE_EVENTS = new Set([
    "TabGroupExpand",
    "TabGroupCollapse",
    "TabGrouped",
    "TabUngrouped",
    "FolderGrouped",
    "FolderUngrouped",
    "TabSelect",
    "TabMove",
    "TabOpen",
    "TabClose",
    "TabAttrModified",
  ]);

  /**
   * nsZenFolderTreeConnectors
   *
   * Managed vertical tree connectors for Zen Browser.
   */
  class nsZenFolderTreeConnectors extends nsZenDOMOperatedFeature {
    static #LINE_X = 6;
    static #STROKE_WIDTH = 2;
    static #BRANCH_RADIUS = 7;
    static #OPACITY = 0.25;
    static #BRANCH_OVERSHOOT = 0;

    #raf = null;
    #resizeObserver = null;
    #mutationObserver = null;
    #windowUtils = window.windowUtils;

    constructor() {
      super();
      XPCOMUtils.defineLazyPreferenceGetter(
        this,
        "ownedTabsInFolderPref",
        "zen.folders.owned-tabs-in-folder",
        false,
        () => this.scheduleUpdate(),
      );
    }

    /**
     * Initializes the tree connector system.
     */
    init() {
      try {
        this.#setupEventListeners();
        this.#refreshVisualRelationships();
        this.scheduleUpdate();
      } catch (e) {
        console.error("ZenFolderTreeConnectors: Failed to initialize", e);
      }
    }

    scheduleUpdate() {
      if (this.#raf) {
        return;
      }
      this.#raf = requestAnimationFrame(() => {
        this.#raf = null;
        this.#onRefreshConnectors();
      });
    }

    /**
     * Main refresh cycle for all connector types.
     */
    #onRefreshConnectors() {
      if (!window.gBrowser) {
        return;
      }

      try {
        const activeWorkspace = document.querySelector(
          "zen-workspace[active='true']",
        );

        this.#refreshVisualRelationships();

        const folders = activeWorkspace
          ? activeWorkspace.querySelectorAll("zen-folder")
          : document.querySelectorAll("zen-folder");
        for (const folder of folders) {
          this.#refreshFolderConnector(folder);
        }

        const relatedParents = activeWorkspace
          ? activeWorkspace.querySelectorAll("tab.zen-is-related-parent")
          : document.querySelectorAll("tab.zen-is-related-parent");
        for (const parent of relatedParents) {
          this.#refreshRelatedTabConnector(parent);
        }
      } catch (e) {
        console.error("ZenFolderTreeConnectors: Error during refresh", e);
      }
    }

    /**
     * Unified event dispatcher.
     */
    handleEvent(aEvent) {
      if (aEvent.type === "TabGroupCreate") {
        this.#registerResizeObservers();
        this.scheduleUpdate();
        return;
      }

      if (SCHEDULE_EVENTS.has(aEvent.type)) {
        this.scheduleUpdate();
        return;
      }

      // transitionend / animationend from scoped container
      if (aEvent.type === "transitionend" || aEvent.type === "animationend") {
        this.scheduleUpdate();
        return;
      }

      throw new Error(`Unexpected event ${aEvent.type}`);
    }

    #setupEventListeners() {
      const events = [...SCHEDULE_EVENTS, "TabGroupCreate"];
      for (const event of events) {
        window.addEventListener(event, this);
      }

      this.#mutationObserver = new MutationObserver(() =>
        this.scheduleUpdate(),
      );
      this.#mutationObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["zen-sidebar-expanded"],
      });

      const arrowScrollbox = document.getElementById(
        "tabbrowser-arrowscrollbox",
      );
      if (arrowScrollbox) {
        this.#mutationObserver.observe(arrowScrollbox, {
          attributes: true,
          attributeFilter: ["active", "collapsedpinnedtabs"],
          subtree: true,
        });

        // Scope transition/animation listeners to the tabs area
        // rather than the entire window to avoid unnecessary repaints.
        arrowScrollbox.addEventListener("transitionend", this, true);
        arrowScrollbox.addEventListener("animationend", this, true);
      }

      this.#registerResizeObservers();
    }

    #registerResizeObservers() {
      if (!this.#resizeObserver) {
        this.#resizeObserver = new ResizeObserver(() => this.scheduleUpdate());
      }
      const containers = document.querySelectorAll(
        "zen-folder > .tab-group-container",
      );
      for (const container of containers) {
        if (!container._tcObserved) {
          container._tcObserved = true;
          this.#resizeObserver.observe(container);
        }
      }
    }

    #observeTabElement(tab) {
      if (!this.#resizeObserver) {
        this.#resizeObserver = new ResizeObserver(() => this.scheduleUpdate());
      }
      if (!tab._tcObserved) {
        tab._tcObserved = true;
        this.#resizeObserver.observe(tab);
      }
    }

    /**
     * Identifies and tags parent-child relationships for visually nested tabs.
     */
    #refreshVisualRelationships() {
      if (!window.gBrowser?.tabs) return;

      if (this.ownedTabsInFolderPref) {
        this.#clearVisualNesting();
        return;
      }

      const tabs = Array.from(window.gBrowser.tabs);
      let activeParent = null;
      let lineage = new Set();

      for (const tab of tabs) {
        tab.classList.remove("zen-is-related-child", "zen-is-related-parent");

        const isBoundary =
          tab.pinned ||
          tab.group ||
          tab.classList.contains("zen-tab-group-start");
        if (isBoundary) {
          activeParent = null;
          lineage.clear();
          continue;
        }

        const owner = tab.ownerTab || tab.openerTab;
        const isDirectChild =
          owner &&
          activeParent &&
          (owner === activeParent || lineage.has(owner));

        if (isDirectChild) {
          tab.classList.add("zen-is-related-child");
          lineage.add(tab);
          activeParent.classList.add("zen-is-related-parent");
          this.#observeTabElement(tab);
          this.#observeTabElement(activeParent);
        } else {
          activeParent = tab;
          lineage.clear();
        }
      }

      this.#pruneStaleConnectors();
    }

    #clearVisualNesting() {
      const nodes = document.querySelectorAll(
        ".zen-is-related-child, .zen-is-related-parent",
      );
      for (const node of nodes) {
        node.classList.remove("zen-is-related-child", "zen-is-related-parent");
        const conn = node.querySelector(":scope > .tree-connector");
        if (conn?._isVisualConnector) {
          conn.hidden = true;
        }
      }
    }

    #pruneStaleConnectors() {
      const connectors = document.querySelectorAll("tab > .tree-connector");
      for (const conn of connectors) {
        if (conn._isVisualConnector) {
          const owner = conn.closest("tab");
          if (!owner?.classList.contains("zen-is-related-parent")) {
            conn.hidden = true;
          }
        }
      }
    }

    #getVisibleChildren(container, isParentCollapsed = false) {
      const folder = container.closest("zen-folder, tab-group");
      const items = folder?.allItems || [];
      if (!items.length) return [];

      let result = [];
      for (const item of items) {
        const isVisible = item.offsetHeight > 0;
        if (!isVisible) continue;

        if (window.gBrowser.isTabGroup(item)) {
          if (item.hasAttribute("split-view-group")) {
            result.push(item);
            continue;
          }

          if (item.isZenFolder) {
            const rootMost = item.rootMostCollapsedFolder;

            // If this folder is collapsed under a different root-most ancestor,
            // recurse into its active child. Otherwise treat it as a leaf node.
            if (isParentCollapsed || (rootMost && rootMost !== item)) {
              const subContainer = item.querySelector(
                ":scope > .tab-group-container",
              );
              if (subContainer) {
                result.push(...this.#getVisibleChildren(subContainer, true));
              }
            } else {
              result.push(item);
            }
          }
        } else if (window.gBrowser.isTab(item)) {
          if (
            !item.classList.contains("zen-tab-group-start") &&
            !item.classList.contains("pinned-tabs-container-separator")
          ) {
            result.push(item);
          }
        }
      }
      return result;
    }

    #refreshFolderConnector(folder) {
      const container = folder.querySelector(":scope > .tab-group-container");
      if (!container) return;

      const rootMost = folder.rootMostCollapsedFolder;
      if (rootMost && rootMost !== folder) {
        const ghost = container.querySelector(":scope > .tree-connector");
        if (ghost) {
          ghost.hidden = true;
          delete ghost._cachedPathElement;
        }
        return;
      }

      const isPinnedSection = folder.closest(
        ".zen-workspace-pinned-tabs-section",
      );
      const workspace = folder.closest("zen-workspace");
      const isPinnedCollapsed =
        isPinnedSection && workspace?.hasAttribute("collapsedpinnedtabs");

      const isExpanded =
        document.documentElement.getAttribute("zen-sidebar-expanded") ===
        "true";
      const isCollapsed = folder.hasAttribute("collapsed");
      const hasActive = folder.hasAttribute("has-active");

      // If the pinned section is collapsed, hide the connector
      if (isPinnedCollapsed) {
        const conn = container.querySelector(":scope > .tree-connector");
        if (conn) {
          conn.hidden = true;
          delete conn._cachedPathElement;
        }
        return;
      }

      const isVisible = !isCollapsed || hasActive;
      const children =
        isExpanded && isVisible
          ? this.#getVisibleChildren(container, isCollapsed)
          : [];

      let connector = container.querySelector(":scope > .tree-connector");
      if (!children.length) {
        if (connector) {
          connector.hidden = true;
        }
        return;
      }

      if (!connector) {
        connector = document.createElement("div");
        connector.className = "tree-connector";
        container.prepend(connector);
      }
      connector.hidden = false;

      this.#performSVGUpdate(connector, children, false);
    }

    #refreshRelatedTabConnector(parent) {
      const descendants = [];
      let sibling = parent.nextElementSibling;
      while (sibling?.classList.contains("zen-is-related-child")) {
        descendants.push(sibling);
        sibling = sibling.nextElementSibling;
      }

      let connector = parent.querySelector(":scope > .tree-connector");
      if (!descendants.length) {
        if (connector?._isVisualConnector) connector.hidden = true;
        return;
      }

      if (!connector) {
        connector = document.createElement("div");
        connector.className = "tree-connector";
        connector._isVisualConnector = true;
        parent.appendChild(connector);
      }
      connector.hidden = false;

      this.#performSVGUpdate(connector, descendants, true, parent);
    }

    #performSVGUpdate(host, targets, isRelated, contextTab = null) {
      const baseRect = this.#windowUtils.getBoundsWithoutFlushing(host);
      const points = targets
        .map((item) => {
          const targetElement = isRelated
            ? item.querySelector(".tab-stack") || item
            : item;
          const itemRect =
            this.#windowUtils.getBoundsWithoutFlushing(targetElement);

          // Prefer checking inline style before  triggering a full getComputedStyle recalc.
          let tx = 0,
            ty = 0;
          const inlineTransform = targetElement.style.transform;
          const transformValue =
            inlineTransform && inlineTransform !== "none"
              ? inlineTransform
              : null;

          if (transformValue) {
            const m = new window.DOMMatrix(transformValue);
            tx = m.m41;
            ty = m.m42;
          } else if (!inlineTransform) {
            // No inline transform set — check computed style as a fallback.
            const computed = window.getComputedStyle(targetElement).transform;
            if (computed && computed !== "none") {
              const m = new window.DOMMatrix(computed);
              tx = m.m41;
              ty = m.m42;
            }
          }

          let x =
            itemRect.left -
            tx -
            baseRect.left +
            nsZenFolderTreeConnectors.#BRANCH_OVERSHOOT;
          let y = itemRect.top - ty - baseRect.top;

          if (!isRelated) {
            if (item.isZenFolder) {
              const label = item.querySelector(
                ":scope > .tab-group-label-container",
              );
              if (label) y += label.offsetHeight / 2;
            } else if (window.gBrowser.isTabGroup(item)) {
              const tab = item.querySelector("tab");
              if (tab) {
                const tabRect = this.#windowUtils.getBoundsWithoutFlushing(tab);
                y = tabRect.top - ty - baseRect.top + tab.offsetHeight / 2;
              } else {
                y += item.offsetHeight / 2;
              }
            } else {
              y += item.offsetHeight / 2;
            }
          } else {
            y += targetElement.offsetHeight / 2;
          }

          return {
            y,
            x,
            r: Math.min(
              nsZenFolderTreeConnectors.#BRANCH_RADIUS,
              Math.max(0, x - nsZenFolderTreeConnectors.#LINE_X),
            ),
          };
        })
        .filter((p) => p.y > 1);

      if (!points.length) {
        host.hidden = true;
        return;
      }

      const last = points[points.length - 1];
      const trunkTerminateY = last.y - last.r;
      if (trunkTerminateY < 0) return;

      const pathStart = isRelated ? contextTab.offsetHeight / 2 : 0;
      let pathData = `M ${nsZenFolderTreeConnectors.#LINE_X} ${pathStart} L ${nsZenFolderTreeConnectors.#LINE_X} ${trunkTerminateY}`;
      for (const { y, x, r } of points) {
        pathData += ` M ${nsZenFolderTreeConnectors.#LINE_X} ${y - r} A ${r} ${r} 0 0 0 ${nsZenFolderTreeConnectors.#LINE_X + r} ${y} L ${x} ${y}`;
      }

      let path = host._cachedPathElement;
      if (!path) {
        path = document.createElementNS(SVG_NS, "path");
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        svg.style =
          "position:absolute;top:0;left:0;overflow:visible;pointer-events:none;";

        const g = document.createElementNS(SVG_NS, "g");
        g.setAttribute("opacity", nsZenFolderTreeConnectors.#OPACITY);
        g.setAttribute("stroke", "currentColor");
        g.setAttribute("stroke-width", nsZenFolderTreeConnectors.#STROKE_WIDTH);
        g.setAttribute("fill", "none");
        g.setAttribute("stroke-linecap", "round");

        g.appendChild(path);
        svg.appendChild(g);
        host.replaceChildren(svg);
        host._cachedPathElement = path;
      }

      if (path.getAttribute("d") !== pathData) {
        path.setAttribute("d", pathData);
      }
    }
  }

  window.gZenFolderTreeConnectors = new nsZenFolderTreeConnectors();
})();
