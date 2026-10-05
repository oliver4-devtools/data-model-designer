// Bootstrap and command wiring.

import { el, clear, $, $$, formatDateTime, productName } from './util.js';
import { host, on, isHosted, isCancellation } from './bridge.js';
import {
  state, subscribe, mutate, newDocument, setDocument, setDirtyNotifier, setDirty,
  undo, redo, canUndo, canRedo, clearSelection, selectOnly, tableById, relationshipById,
  removeTable, removeRelationship, removeAnnotation, notify, newAnnotation,
  syncProposedLookupColumn, annotationBehind, NOTE_DEFAULT_SIZE
} from './state.js';
import { initRenderer, render, refreshRendererTheme, routeFor } from './render.js';
import {
  initInteractions, fitToView, zoomStep, resetZoom, resetView, zoomTo, focusTable, deleteSelection,
  toWorld, startConnectMode, startDrawMode, endDrawMode, isTypingTarget
} from './interact.js';
import { initPanels, renderPanels } from './panels.js';
import { initInspector, refreshInspector, hideInspector } from './inspector.js';
import {
  openModal, closeModal, modalFooter, toast, updateProgress, hostProgressDone,
  withProgress, showContextMenu, hideContextMenu, isModalOpen, field, textInput, versionLine,
  clampToViewport, furniturePosition
} from './ui.js';
import { openSourcePicker, invalidateCatalogue, refreshSourcePicker } from './sourcepicker.js';
import {
  openProposedTableEditor, openProposedColumnEditor, setTableStatus,
  openProposeHub, openProposedRelationshipEditor
} from './proposed.js';
import { openExplorer } from './explorer.js';
import { openCascadeAnalysis } from './cascade.js';
import { openExportDialog } from './exporter.js';
import { runRefresh } from './refresh.js';
import {
  openDisplaySettings, openDiagramProperties, openPathFinder, openLayoutMenu, openFeatureGuide
} from './dialogs.js';
import { invalidateSizes, statusStyle, cornersWithout } from './geometry.js';
import { setTheme, currentTheme, emphasisHead, emphasisName } from './theme.js';

// ------------------------------------------------------------------ boot --

let appInfo = null;

// An app.info retry that is still in flight, so two dialogs opened in quick succession share one
// round trip rather than each asking the host again. Up here with appInfo, and above the boot
// block, for the temporal-dead-zone reason spelled out on lastBarSignature below.
let appInfoRetryRequest = null;

// Declared up here, not next to layoutCommandBar where it is used, because the boot sequence
// below calls paintChrome() -> layoutCommandBar() while this module is still evaluating. A `let`
// further down the file is in its temporal dead zone at that point, and reading it throws.
let lastBarSignature = '';

/**
 * What the command bar gives up as the window narrows, least missed first.
 *
 * One entry per thing that can be shelved, and buttons leave one at a time, so the bar never
 * shows a band of empty space where there is still room for some of them.
 *
 * `menu` is the same entry as it appears in the overflow menu, so the bar and the menu are driven
 * by one table and cannot disagree about which buttons have moved.
 *
 * Same reason as lastBarSignature for living up here: layoutCommandBar runs during boot.
 */
const BAR_ITEMS = [
  {
    key: 'connection', selector: '#connection-chip',
    label: () => state.connection && state.connection.connected
      ? 'Connected: ' + (state.connection.host || state.connection.organizationFriendlyName || '')
      : 'Not connected'
  },
  { key: 'refresh', selector: '[data-command="refresh"]',
    menu: () => ({ text: 'Refresh from Dataverse', run: () => runRefresh() }) },
  { key: 'display', selector: '[data-command="display-settings"]',
    menu: () => ({ text: 'Display settings...', run: () => openDisplaySettings() }) },
  { key: 'toggle-grid', selector: '[data-command="toggle-grid"]',
    menu: () => ({
      text: state.doc.settings.showGrid ? 'Hide canvas grid' : 'Show canvas grid',
      run: () => toggleGrid()
    }) },
  { key: 'toggle-theme', selector: '[data-command="toggle-theme"]',
    menu: () => ({
      text: currentTheme() === 'dark' ? 'Light mode' : 'Dark mode',
      run: () => toggleTheme()
    }) },
  // The draw tools go before the model commands: a diagram can be built without them, and they
  // are the three things on the bar that are quickest to reach from the menu instead.
  //
  // Auto-layout sits at the end of that group on the bar, so it is shelved at the head of it here:
  // the group then empties from its right-hand end, which is the only order that does not leave a
  // gap between the buttons that are left. It is one click from the menu either way.
  { key: 'auto-layout', selector: '[data-command="auto-layout"]',
    menu: anchor => ({ text: 'Auto-layout...', run: () => openLayoutMenu(anchor) }) },
  { key: 'add-arrow', selector: '[data-command="add-arrow"]',
    menu: () => ({ text: 'Draw an arrow', run: () => startDrawing('arrow') }) },
  { key: 'add-text', selector: '[data-command="add-text"]',
    menu: () => ({ text: 'Add a text box', run: () => startDrawing('text') }) },
  // Takes the group's label and divider with it, so the last draw button to leave does not leave
  // the word "Draw" sitting on the bar with nothing after it.
  { key: 'add-sticky', selector: '[data-command="add-sticky"], .draw-label, .bar-divider.draw-divider',
    menu: () => ({ text: 'Add a sticky note', run: () => startDrawing('note') }) },
  { key: 'detail', selector: '.detail-switch, .bar-divider.detail-divider', detail: true },
  { key: 'cascade', selector: '[data-command="cascade"]',
    menu: () => ({ text: 'Cascade impact...', run: () => openCascadeAnalysis() }) },
  { key: 'find-path', selector: '[data-command="find-path"]',
    menu: () => ({ text: 'Find relationship path...', run: () => openPathFinder() }) },
  { key: 'propose', selector: '[data-command="propose"]',
    menu: () => ({ text: 'Propose new tables...', run: () => openProposeHub(centreOfCanvas()) }) },
  { key: 'explore', selector: '[data-command="explore"]',
    menu: () => ({ text: 'Explore relationships...', run: () => openExplorer() }) }
];

/** Keys currently shelved. Read by showMainMenu to rebuild the overflow list. */
const shelved = new Set();

/** Same purpose as lastBarSignature, for the legend rows. Boot calls paintChrome, so: up here. */
let lastLegendSignature = null;

/** The legend drag in progress, or null. Up here for the same temporal-dead-zone reason. */
let legendDrag = null;

/** The last placement applied to the legend, so paintChrome does not re-measure it every time. */
let lastLegendPlacement = null;

/**
 * Space kept clear above the legend, matching TOP_CHROME_HEIGHT in render.js.
 *
 * The command bar floats over the canvas, so without this the legend can be dragged underneath it
 * and left there - visible only as an edge, and no longer draggable by the part that shows.
 */
const LEGEND_TOP_INSET = 84;

initRenderer();
initPanels({ onInspect: refreshInspector });
initInspector();
initInteractions({
  onSelectionChange: () => { refreshInspector(); renderPanels(); },
  onContextMenu: showCanvasMenu,
  onOpenEditor: openEditorFor,
  onConnect: (fromTableId, toTableId) =>
    openProposedRelationshipEditor({ fromTableId, toTableId }),
  onAnnotationPlaced: focusAnnotationText
});

initLegendDrag();

wireFailureReporting();

setDirtyNotifier((dirty, title) => {
  host.setDirty(dirty, title).catch(() => {});
  paintChrome();
});

subscribe(() => paintChrome());

// Anything floating over the canvas is holding objects from the document being replaced: a context
// menu item captures the table it was opened on, and an open dialog edits the document it was built
// from, so both are closed here. Done on the notification every replacing route already raises, so
// no route has to remember to do it itself.
subscribe(reason => {
  if (reason !== 'document-replacing') return;
  hideContextMenu();
  closeModal();

  // A legend drag in flight belongs to the document that is going. Committed after the swap it
  // would write into the new document's settings and mark a diagram nobody has touched as unsaved.
  cancelLegendDrag();

  // The incoming document has its own legend position, and the outgoing one's placement must not
  // be mistaken for it.
  lastLegendPlacement = null;
});

wireCommandBar();
wireHostEvents();
wireGlobalShortcuts();

setTheme('light');
setDocument(newDocument(), null);
render();
renderPanels();
paintChrome();

// The tool opens on the question it exists to answer: what should this diagram be built from.
// This runs before the host round trips, so the dialog appears straight away even if getSettings
// or getConnection is slow or fails. The dialog repaints itself when the connection arrives (see
// refreshSourcePicker).
openSourcePicker({ mode: 'new' });

bootstrap();

async function bootstrap() {
  if (!isHosted) {
    toast('Running outside XrmToolBox, so Dataverse features are unavailable.', 'warning', { sticky: true });
    return;
  }

  try {
    state.settings = await host.getSettings();
  } catch (error) {
    state.settings = null;
  }

  applyStoredTheme();

  try {
    state.connection = await host.getConnection();
  } catch (error) {
    state.connection = { connected: false };
  }

  try {
    appInfo = await host.getAppInfo();
  } catch (error) {
    appInfo = null;
  }

  paintChrome();
  refreshSourcePicker();
}

/**
 * A second attempt at app.info, or null when there is nothing to wait for.
 *
 * The fetch in bootstrap() is the only one, and it can come back empty. This retry is the
 * safeguard for that, because the About box and the feature guide both need to name the release.
 * Cached on success, and cleared on failure so the next opener tries again rather than inheriting
 * one bad answer for the session.
 */
function appInfoRetry() {
  if (appInfo || !isHosted) return null;

  if (!appInfoRetryRequest) {
    appInfoRetryRequest = host.getAppInfo()
      .then(info => { appInfo = info || null; return appInfo; })
      .catch(() => { appInfoRetryRequest = null; return null; });
  }

  return appInfoRetryRequest;
}

// -------------------------------------------------------------- failures --

/**
 * Anything that gets past a local try/catch.
 *
 * The canvas is an embedded browser with no address bar and no visible console, so an uncaught
 * error would otherwise leave a diagram that has quietly stopped responding to one command with
 * nothing on screen to say why. This does not pretend to recover - it says what happened, and
 * says the diagram is still intact, which is the question the user actually has.
 */
function wireFailureReporting() {
  let reported = 0;

  const report = detail => {
    // Capped: a render loop that throws on every frame would otherwise bury the canvas in toasts.
    if (reported >= 3) return;
    reported++;

    toast(
      'Something went wrong inside the designer: ' + detail + '.\n' +
      'Your diagram has not been changed. Save it, and if this keeps happening, close and reopen ' +
      'the tool.' + (reported === 3 ? '\n\nFurther messages of this kind will be suppressed.' : ''),
      'error', { sticky: true });
  };

  window.addEventListener('error', event => {
    console.error('Uncaught error', event.error || event.message);
    report(event.message || 'unexpected error');
  });

  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason;

    // A cancellation is a rejection like any other - it is how the host answers a request it was
    // told to stop - but it is the user pressing Cancel, not a fault. Filtered before the count, so
    // it neither reports an error nor uses up one of the capped reports.
    if (isCancellation(reason)) return;

    console.error('Unhandled rejection', reason);
    report(reason && reason.message ? reason.message : String(reason || 'unexpected error'));
  });
}

// ---------------------------------------------------------------- theme --

function applyStoredTheme() {
  const stored = state.settings && state.settings.theme === 'dark' ? 'dark' : 'light';
  if (stored === currentTheme()) return;

  setTheme(stored);
  refreshRendererTheme();
  paintChrome();
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';

  setTheme(next);
  refreshRendererTheme();
  paintChrome();
  refreshInspector();

  // App-level preference, not a diagram one: it is not written into the .dvmd file and does not
  // mark the diagram dirty.
  if (state.settings) {
    state.settings.theme = next;
    host.saveSettings(state.settings).catch(() => {});
  }
}

function toggleGrid() {
  mutate('canvas grid', () => {
    state.doc.settings.showGrid = !state.doc.settings.showGrid;
  });
  render();
  paintChrome();
}

// -------------------------------------------------------------- chrome ---

function paintChrome() {
  const doc = state.doc;

  const title = doc.title + (state.dirty ? ' *' : '');
  const titleButton = $('#diagram-title');
  titleButton.textContent = title;
  titleButton.title = title + ' - click to rename';

  $('#title-block-title').textContent = doc.title;
  $('#title-block').hidden = !doc.settings.showTitleBlock;
  $('#legend').hidden = !doc.settings.showLegend;

  // Rows first: the legend is placed from its own measured size, and a legend that has just
  // gained an emphasis row is taller than the one that was on screen a moment ago.
  if (doc.settings.showLegend) paintLegend();

  // Outside the branch on purpose. A hidden legend measures 0x0, so a placement worked out while
  // it was switched off would be cached as if it were real - and the guard would then skip the
  // placement it needed on the way back. applyLegendPosition knows about that; the caller does not
  // have to.
  applyLegendPosition();

  // The description is drawn on the canvas as well as in the exported title block, so the line
  // saying who a diagram is for is visible in the tool itself.
  const description = $('#title-block-desc');
  description.textContent = doc.description || '';
  description.hidden = !doc.description;

  const source = doc.source || {};
  const subtitleParts = [];
  if (source.organizationFriendlyName) subtitleParts.push(source.organizationFriendlyName);
  if (source.lastRefreshUtc) subtitleParts.push('refreshed ' + formatDateTime(source.lastRefreshUtc));
  $('#title-block-sub').textContent = subtitleParts.join('  ·  ');

  $('#zoom-level').textContent = Math.round(state.view.zoom * 100) + '%';

  $$('.seg[data-detail]').forEach(button => {
    button.classList.toggle('is-active', button.dataset.detail === doc.settings.fieldDetail);
  });

  const chip = $('#connection-chip');
  const dot = chip.querySelector('.dot');
  const connected = state.connection && state.connection.connected;

  dot.className = 'dot ' + (connected ? 'dot-on' : 'dot-off');
  $('#connection-name').textContent = connected
    ? (state.connection.host || state.connection.organizationFriendlyName || 'Connected')
    : 'Not connected';
  chip.title = connected
    ? (state.connection.organizationFriendlyName || '') + '\n' +
      (state.connection.environmentUrl || '') + '\n' +
      (state.connection.userName || '')
    : 'Connect to an environment using the XrmToolBox connection bar';

  $$('[data-command="undo"]').forEach(b => { b.disabled = !canUndo(); });
  $$('[data-command="redo"]').forEach(b => { b.disabled = !canRedo(); });

  const grid = $('#grid-toggle');
  grid.classList.toggle('is-on', !!doc.settings.showGrid);
  grid.title = doc.settings.showGrid ? 'Hide the canvas grid' : 'Show the canvas grid';

  // The label says what pressing it will do, not what the canvas is now: "Dark mode" on a light
  // canvas is an instruction.
  const dark = currentTheme() === 'dark';
  const themeButton = $('#theme-toggle');
  const themeGlyph = themeButton.querySelector('.btn-glyph');
  const themeLabel = $('#theme-label');

  if (themeGlyph) themeGlyph.innerHTML = dark ? '&#9788;' : '&#9789;';
  if (themeLabel) themeLabel.textContent = dark ? 'Light mode' : 'Dark mode';
  themeButton.title = dark ? 'Switch to light mode' : 'Switch to dark mode';

  // The mark is drawn for a light ground. On the dark canvas it needs its own artwork rather than
  // the same file dimmed, so the two versions are shipped and swapped here.
  $('#brand-logo').setAttribute('src', dark ? 'img/logo-dark.png' : 'img/logo.png');

  layoutCommandBar();
}

/**
 * The logo file for the current theme, at the size the caller asks for.
 *
 * 256px artwork exists because the lockup carries the OLIVER 4 wordmark, and lettering goes soft
 * when a smaller file is scaled up on a high-DPI display at the sizes the About box and the
 * feature guide draw it.
 */
function logoSrc(size) {
  const dark = currentTheme() === 'dark';
  if (size === 256) return dark ? 'img/logo-dark-256.png' : 'img/logo-256.png';
  if (size === 128) return dark ? 'img/logo-dark-128.png' : 'img/logo-128.png';
  return dark ? 'img/logo-dark.png' : 'img/logo.png';
}

/**
 * The on-canvas legend.
 *
 * Built from the live palette rather than written into the HTML, so each swatch matches what a
 * card actually looks like - a pale status fill inside a coloured, sometimes dashed border - in
 * both themes.
 *
 * Emphasis colours are listed too, because a card recoloured by hand is no longer described by its
 * status swatch.
 */
function paintLegend() {
  const colours = emphasisInUse();

  // paintChrome runs on every change notification, including one per wheel tick while zooming, and
  // rebuilding the legend rows on each of those is work for nothing. Same guard as the command bar.
  const signature = [
    currentTheme(),
    state.doc.settings.showOwnership ? 'own' : '',
    colours.map(colour => colour + '=' + emphasisName(colour)).join(',')
  ].join('|');

  if (signature === lastLegendSignature) return;
  lastLegendSignature = signature;

  const rows = clear($('#legend-rows'));

  for (const status of ['Existing', 'Proposed', 'External', 'Deprecated']) {
    rows.appendChild(legendRow(statusSwatch(statusStyle(status)), status));
  }

  for (const colour of colours) {
    const swatch = el('span', {
      class: 'swatch',
      style: {
        background: emphasisHead(colour),
        border: '1.2px solid ' + colour
      }
    });

    const row = legendRow(swatch, emphasisName(colour));
    row.classList.add('legend-named');
    row.title = 'Click to name this colour';

    // The colour is read back off the row by the drag below rather than closed over by a click
    // listener here. See the pointer-capture note in onLegendPointerMove for why a click listener on
    // this row cannot be relied on.
    row.setAttribute('data-emphasis', colour);
    rows.appendChild(row);
  }

  if (state.doc.settings.showOwnership) {
    const row = legendRow(el('span', { class: 'ownership-pill', text: 'USER' }), 'Ownership');
    row.classList.add('legend-ownership');
    rows.appendChild(row);
  }
}

function legendRow(swatch, label) {
  return el('div', { class: 'legend-row' }, [swatch, el('span', { text: label })]);
}

/**
 * The legend is dragged like anything else on the canvas.
 *
 * It sits in the bottom-right corner by default, which can be in the way of a diagram whose cards
 * run that way, and the zoom pill and the title block have the other two corners.
 *
 * The position is stored in the diagram rather than in the tool settings: it is part of how this
 * drawing is laid out, so it belongs in the .dvmd file with the view and the grid. Additive, so
 * the file format version does not move - an older build ignores the two properties and draws the
 * legend in the corner.
 */
function initLegendDrag() {
  const legend = $('#legend');
  if (!legend) return;

  legend.title = 'Drag to move the legend. Right-click for options.';

  legend.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;

    const rect = legend.getBoundingClientRect();
    const row = event.target && event.target.closest ? event.target.closest('.legend-named') : null;

    legendDrag = {
      pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY,
      originX: rect.left, originY: rect.top,
      moved: false, at: null,

      // The row the press landed on, if it was one. Captured here because by the time the button
      // comes up the pointer may be somewhere else entirely.
      colour: row ? row.getAttribute('data-emphasis') : null
    };
  });

  // On the window rather than on the legend: a pointer that leaves the legend mid-drag - which it
  // does the moment the drag is faster than the repaint - would otherwise stop being tracked and
  // the legend would stick to the pointer with no way to drop it.
  window.addEventListener('pointermove', onLegendPointerMove);
  window.addEventListener('pointerup', onLegendPointerUp);

  // A cancelled pointer is not a finished drag: the gesture was taken away, usually by the browser
  // turning a touch drag into a pan. It is dropped without committing, so no half move is written
  // into the diagram and the next click on a colour row is not swallowed.
  window.addEventListener('pointercancel', cancelLegendDrag);

  // The same reason interact.js drops its own drag state on blur: a pointer released while the
  // window is not focused never reports the release, and the legend would follow the pointer
  // again the next time it moved over the canvas.
  window.addEventListener('blur', cancelLegendDrag);

  legend.addEventListener('contextmenu', event => {
    event.preventDefault();
    showLegendMenu(event);
  });

}

/** Drops a drag in progress without committing it, and puts the legend back where it was. */
function cancelLegendDrag() {
  if (!legendDrag) return;

  legendDrag = null;

  const legend = $('#legend');
  if (legend) legend.classList.remove('is-dragging');

  // The live drag wrote straight onto the element, so the stored position has to be redrawn.
  lastLegendPlacement = null;
  applyLegendPosition();
}

function onLegendPointerMove(event) {
  if (!legendDrag) return;

  // Another pointer - a second touch, a stylus - is not this drag.
  if (event.pointerId !== undefined && legendDrag.pointerId !== undefined &&
      event.pointerId !== legendDrag.pointerId) return;

  // The button was released somewhere the release could not be reported: outside the WebView, or
  // over host chrome. Pointer capture makes this rare rather than impossible, so the drag ends
  // here rather than resuming the moment the pointer comes back over the canvas.
  if (event.buttons === 0) {
    cancelLegendDrag();
    return;
  }

  const dx = event.clientX - legendDrag.startX;
  const dy = event.clientY - legendDrag.startY;

  // A few pixels of travel before this becomes a drag, so that clicking a colour row to rename it
  // is not treated as a one-pixel move of the legend.
  if (!legendDrag.moved) {
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    legendDrag.moved = true;

    const legend = $('#legend');
    legend.classList.add('is-dragging');

    // Capture is taken here rather than on pointerdown.
    //
    // Capture is what makes a release outside the WebView arrive, so a drag needs it or the legend
    // goes on following the pointer the next time it crosses the window with no button held down.
    // But while an element holds the capture the browser also retargets the *click* to it, so with
    // it taken on every press the click from a plain press-and-release would land on #legend rather
    // than on the row inside it, and the row's rename action would never run.
    //
    // Taken once the press has become a drag, so the press that is only a press never has it.
    if (legend.setPointerCapture && legendDrag.pointerId !== undefined) {
      try { legend.setPointerCapture(legendDrag.pointerId); } catch (e) { /* not fatal */ }
    }
  }

  event.preventDefault();
  legendDrag.at = placeLegend(legendDrag.originX + dx, legendDrag.originY + dy);
}

function onLegendPointerUp(event) {
  // Releasing a *different* button mid-drag is not the end of this drag, so pressing and releasing
  // the right button while the left one is still down leaves the drag running.
  if (event && event.type === 'pointerup' && event.button !== undefined && event.button !== 0) return;
  if (event && event.pointerId !== undefined && legendDrag &&
      legendDrag.pointerId !== undefined && event.pointerId !== legendDrag.pointerId) return;

  const drag = legendDrag;
  legendDrag = null;
  if (!drag) return;

  const legend = $('#legend');
  if (legend) legend.classList.remove('is-dragging');

  // A press that never became a drag is a click on whatever it went down on. Acted on here rather
  // than in a click listener: see the capture note in onLegendPointerMove for why a click on a row
  // inside the legend cannot be relied on to reach that row.
  if (!drag.moved) {
    if (drag.colour) renameEmphasis(drag.colour);
    return;
  }

  if (!drag.at) return;

  // Committed as one undoable step, like every other drag on the canvas. The clamped point is
  // what is stored, because that is where the legend actually is.
  mutate('move legend', () => {
    state.doc.settings.legendX = Math.round(drag.at.x);
    state.doc.settings.legendY = Math.round(drag.at.y);
  });
}

/** Where the legend has been dragged to, or null when it belongs in the stylesheet's corner. */
function legendPosition() {
  const settings = state.doc.settings || {};
  return furniturePosition(settings.legendX, settings.legendY);
}

/** Draws the legend where the diagram says it goes, or leaves it in the stylesheet's corner. */
function applyLegendPosition() {
  const legend = $('#legend');
  if (!legend) return;

  // `hidden` is `display: none`, so the legend measures 0x0 and the clamp would put it hard
  // against the far edge of the window. Nothing is drawn, so nothing needs placing - but the
  // cached placement has to go with it, or switching the legend back on after resizing the window
  // would be skipped by the guard below and leave it off the edge of the screen.
  if (legend.hidden) {
    lastLegendPlacement = null;
    return;
  }

  const at = legendPosition();

  // paintChrome runs on every change notification, including one per wheel tick while zooming, and
  // measuring the legend and writing four style properties on each of those is work for nothing.
  // Same guard as the command bar and the legend rows - and it has to include the row signature,
  // because a legend that has just gained a colour row is taller than the one on screen.
  const signature = [
    at ? at.x + ',' + at.y : 'corner',
    window.innerWidth, window.innerHeight, lastLegendSignature
  ].join('|');

  if (signature === lastLegendPlacement) return;
  lastLegendPlacement = signature;

  if (!at) {
    // Clearing the inline properties rather than computing the corner here keeps one definition
    // of where the legend lives by default, in app.css beside every other piece of furniture.
    legend.style.left = '';
    legend.style.top = '';
    legend.style.right = '';
    legend.style.bottom = '';
    return;
  }

  placeLegend(at.x, at.y);
}

function placeLegend(x, y) {
  const legend = $('#legend');
  if (!legend) return { x, y };

  const rect = legend.getBoundingClientRect ? legend.getBoundingClientRect() : null;

  const at = clampToViewport(x, y,
    { width: (rect && rect.width) || 0, height: (rect && rect.height) || 0 },
    { width: window.innerWidth, height: window.innerHeight },
    { top: LEGEND_TOP_INSET });

  legend.style.left = Math.round(at.x) + 'px';
  legend.style.top = Math.round(at.y) + 'px';
  legend.style.right = 'auto';
  legend.style.bottom = 'auto';

  return at;
}

function showLegendMenu(event) {
  const moved = !!legendPosition();

  showContextMenu(event.clientX, event.clientY, [
    { label: 'Legend' },
    {
      text: 'Reset position',
      disabled: !moved,
      run: () => {
        mutate('legend position', () => {
          state.doc.settings.legendX = null;
          state.doc.settings.legendY = null;
        });
        paintChrome();
      }
    },
    { separator: true },
    {
      text: 'Hide legend',
      run: () => {
        mutate('toggle showLegend', () => { state.doc.settings.showLegend = false; });
        paintChrome();

        // The legend and the menu that hides it disappear together, so without this the way back
        // is a dialog the user has no reason to open.
        toast('Legend hidden. Display settings brings it back, and Ctrl+Z undoes this.', 'info');
      }
    }
  ]);
}

function statusSwatch(style) {
  return el('span', {
    class: 'swatch',
    style: {
      background: style.fill,
      border: '1.2px ' + (style.dash ? 'dashed' : 'solid') + ' ' + style.mark
    }
  });
}

/** Distinct emphasis colours on the diagram right now, in a stable order. */
function emphasisInUse() {
  const seen = [];

  for (const object of state.doc.tables.concat(state.doc.relationships)) {
    const colour = object.highlight;
    if (colour && !seen.includes(colour)) seen.push(colour);
  }

  return seen.sort();
}

/** Names an emphasis colour, so the legend says "Phase 2" rather than "Teal". */
function renameEmphasis(colour) {
  const key = String(colour).toLowerCase();
  const names = (state.doc.settings.emphasisNames) || {};
  let value = names[key] || '';

  openModal({
    title: 'Name this colour',
    width: 460,
    padded: true,
    body: () => el('div', {}, [
      el('div', {
        style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }
      }, [
        el('span', {
          class: 'swatch',
          style: {
            width: '22px', height: '18px', borderRadius: '5px',
            background: emphasisHead(colour), border: '1.5px solid ' + colour
          }
        }),
        el('span', { class: 'small muted', text: colour })
      ]),
      field('Name', textInput(value, next => { value = next; }),
        'Shown in the legend and in exports. Leave it empty to go back to the colour name.')
    ]),
    footer: api => modalFooter(api, {
      primaryLabel: 'Save',
      onPrimary: () => {
        mutate('name colour', () => {
          const map = Object.assign({}, state.doc.settings.emphasisNames || {});
          if (value.trim()) map[key] = value.trim();
          else delete map[key];
          state.doc.settings.emphasisNames = map;
        });

        render();
        paintChrome();
        refreshInspector();
        api.close(null);
      }
    })
  });
}

function layoutCommandBar() {
  const bar = $('#command-bar');
  if (!bar) return;

  // paintChrome runs on every change notification, including one per wheel tick while zooming.
  // Each measurement below forces a layout, so the whole pass is skipped unless something that
  // can actually change the fit has moved.
  // The theme label is part of the signature: "Dark mode" and "Light mode" are different widths,
  // so a theme switch after a resize has to measure the bar again.
  const signature = bar.clientWidth + '|' + $('#connection-name').textContent.length +
                    '|' + ($('#theme-label') ? $('#theme-label').textContent : '');
  if (signature === lastBarSignature) return;
  lastBarSignature = signature;

  shelved.clear();
  for (const item of BAR_ITEMS) setShelved(bar, item, false);
  bar.classList.remove('hide-brand-text');

  for (const item of BAR_ITEMS) {
    if (fits(bar)) break;
    setShelved(bar, item, true);
    shelved.add(item.key);
  }

  // Last resort at genuinely small widths: the tool's own name goes, and the brand block shrinks
  // to the logo and the diagram name. The diagram name stays because it is the only thing on the
  // bar that says which file is open.
  if (!fits(bar)) bar.classList.add('hide-brand-text');
}

function fits(bar) {
  return bar.scrollWidth <= bar.clientWidth + 1;
}

function setShelved(bar, item, hidden) {
  for (const node of $$(item.selector, bar)) node.classList.toggle('is-shelved', hidden);
}

function wireCommandBar() {
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-command]');
    if (!button) return;

    // runCommand is async, so a failure inside it would otherwise become an unhandled rejection:
    // the button appears to do nothing and the only trace is in a dev-tools console the user is
    // not looking at.
    Promise.resolve(runCommand(button.dataset.command, button)).catch(error => {
      // A cancellation reaches here as a rejection like any other, because that is how the host
      // answers a request it was told to stop. It is not a failure and withProgress has already
      // acknowledged it, so saying "that command could not be completed" as well would tell the
      // user off for pressing the Cancel button the tool offered them.
      if (isCancellation(error)) return;

      console.error('Command failed', button.dataset.command, error);
      toast('That command could not be completed: ' +
        (error && error.message ? error.message : 'unexpected error') + '.', 'error');
    });
  });

  $$('.seg[data-detail]').forEach(button => {
    button.addEventListener('click', () => {
      mutate('field detail', () => {
        state.doc.settings.fieldDetail = button.dataset.detail;
      });
      invalidateSizes();
      render();
      paintChrome();
    });
  });

  $('#diagram-title').addEventListener('click', openDiagramProperties);
  $('#zoom-level').addEventListener('click', event => showZoomMenu(event.currentTarget));
  $('#connection-chip').addEventListener('click', () => {
    if (!state.connection || !state.connection.connected) {
      toast('Use the connection bar at the top of XrmToolBox to connect to an environment.', 'info');
      return;
    }
    toast(
      (state.connection.organizationFriendlyName || 'Connected') + '\n' +
      (state.connection.environmentUrl || '') +
      (state.connection.organizationVersion ? '\nVersion ' + state.connection.organizationVersion : ''),
      'info');
  });
}

async function runCommand(command, button) {
  switch (command) {
    case 'add-tables': return openSourcePicker({ mode: state.doc.tables.length ? 'add' : 'new' });
    case 'explore': return openExplorer();
    case 'auto-layout': return openLayoutMenu(button);
    case 'propose': return openProposeHub(centreOfCanvas());
    case 'add-sticky': return startDrawing('note');
    case 'add-text': return startDrawing('text');
    case 'add-arrow': return startDrawing('arrow');
    case 'find-path': return openPathFinder();
    case 'cascade': return openCascadeAnalysis();
    case 'features': return openFeatureGuide(appInfo, appInfoRetry());
    case 'display-settings': return openDisplaySettings();
    case 'refresh': return runRefresh();
    case 'save': return saveDiagram(false);
    case 'close': return closeDiagram();
    case 'export': return openExportDialog();
    case 'menu': return showMainMenu(button);
    case 'toggle-theme': return toggleTheme();
    case 'toggle-grid': return toggleGrid();

    case 'zoom-in': return zoomStep(1);
    case 'zoom-out': return zoomStep(-1);
    case 'fit': return fitToView();
    case 'undo': stepHistory(undo); return;
    case 'redo': stepHistory(redo); return;
    default: return;
  }
}

function showMainMenu(anchor) {
  const rect = anchor.getBoundingClientRect();

  const recent = ((state.settings && state.settings.recentFiles) || []).slice(0, 6);

  // Whatever the responsive pass took off the bar comes back here, at the top, so the menu is a
  // reliable home for every command rather than a leftovers drawer that changes shape silently.
  // Built from BAR_ITEMS in reverse, so the least-missed thing - the one shelved first - is last.
  const overflow = [];

  // Status lines go at the top rather than wherever the reverse loop happens to put them. The
  // connection chip is the first thing shelved and therefore in every non-empty overflow list, and
  // as the last entry it would read as a section heading with a separator under it and nothing
  // beneath.
  const status = [];

  for (const item of BAR_ITEMS.slice().reverse()) {
    if (!shelved.has(item.key)) continue;

    if (item.menu) { overflow.push(item.menu(anchor)); continue; }

    if (item.detail) {
      overflow.push({ label: 'Field detail' });
      for (const [value, label] of [
        ['TablesOnly', 'Tables only'],
        ['RelationshipFields', 'Relationship columns'],
        ['AllFields', 'All selected columns']
      ]) {
        overflow.push({
          text: label,
          checked: state.doc.settings.fieldDetail === value,
          run: () => setFieldDetail(value)
        });
      }

      // The group is a label with three radio items under it, and whatever the reverse loop puts
      // next would otherwise read as a fourth one.
      overflow.push({ separator: true });
      continue;
    }

    if (item.label) status.push({ label: item.label() });
  }

  if (status.length && overflow.length) status.push({ separator: true });
  if (overflow.length || status.length) overflow.push({ separator: true });

  showContextMenu(rect.left - 180, rect.bottom + 6, [
    ...status,
    ...overflow,
    { text: 'New diagram...', run: () => newDiagram() },
    { text: 'Open diagram...', run: () => openDiagram() },
    { text: 'Save as...', run: () => saveDiagram(true) },
    // Distinct from New: New asks what the next diagram should be built from, Close simply puts
    // the current one away.
    { text: 'Close diagram', disabled: !hasContent(), run: () => closeDiagram() },
    { text: 'Export...', run: () => openExportDialog() },
    { separator: true },
    { text: 'Diagram properties...', run: openDiagramProperties },
    { separator: true },
    ...(recent.length ? [{ label: 'Recent' }] : []),
    ...recent.map(path => ({
      text: shortPath(path),
      run: () => openDiagram(path, true)
    })),
    { separator: true },
    { text: 'What this tool can do', run: () => openFeatureGuide(appInfo, appInfoRetry()) },
    { text: 'About this tool', run: showAbout }
  ]);
}

/**
 * One step back or forward through the history.
 *
 * The size cache is dropped as well as the canvas redrawn. Undo swaps in a clone of the document,
 * so every table keeps its id while its columns become different objects - and a rename changes no
 * count, no tick and no relationship, which is most of what the cache key is made of. Without this
 * the card would go on drawing the name that has just been undone, and the cached rows would point
 * at objects in a discarded document.
 */
function stepHistory(step) {
  // Any open context menu was built against the document that is about to be replaced, and its
  // items hold references to objects in it. Nothing else dismisses it - the menu closes on a click
  // or a wheel outside itself, not on a keystroke - so Ctrl+Z with a menu open would leave every
  // command on it pointing at a table or a connector that no longer exists.
  hideContextMenu();

  step();
  invalidateSizes();
  render();
  renderPanels();
  refreshInspector();
}

/**
 * Which corner of a connector the right-click landed on, or null when it did not land on one or
 * that bend is not the user's to remove.
 *
 * The handles sit in the overlay layer above everything else, so a right-click on one has the
 * handle as its target while the hit test underneath still resolves to the connector - which is
 * what puts the item on that connector's own menu rather than on a menu of its own.
 */
function bendUnderPointer(event, relationshipId) {
  const handle = event && event.target && event.target.closest
    ? event.target.closest('[data-corner]') : null;
  if (!handle) return null;

  // The handle has to belong to the connector whose menu this is. They are resolved separately -
  // the handle by its own attribute, the menu by the hit test - and a corner of one connector is
  // not a bend anybody can take out of another.
  if (handle.getAttribute('data-id') !== relationshipId) return null;

  const relationship = relationshipById(relationshipId);
  const route = relationship ? routeFor(relationshipId) : null;
  if (!route) return null;

  const index = Number(handle.getAttribute('data-corner'));
  return cornersWithout(relationship, route.fanIndex, route.fanCount, index) === null ? null : index;
}

/** Takes one bend out of a connector, leaving the rest of the route where the user put it. */
function removeBend(relationshipId, index) {
  const relationship = relationshipById(relationshipId);
  const route = relationship ? routeFor(relationshipId) : null;
  if (!route) return;

  const reduced = cornersWithout(relationship, route.fanIndex, route.fanCount, index);
  if (reduced === null) return;

  mutate('remove bend', () => {
    relationship.waypoints = reduced;

    // The corners the route is drawn through now carry the whole shape, so the two offsets - which
    // move the middle of an *automatic* route - have nothing left to move and would apply twice.
    // An empty list means the connector is back on its automatic route, and there they are what
    // the user last dragged, so they stay.
    if (reduced.length) {
      relationship.routeOffset = 0;
      relationship.routeOffsetCross = 0;
    }
  });

  render();
  refreshInspector();
}

/**
 * Whether a connector is carrying any routing of the user's own - either of the two offsets, or a
 * corner moved by hand. What "Straighten this connector" is offered for, and what it undoes.
 */
function handRouted(relationship) {
  return !!(relationship.routeOffset || relationship.routeOffsetCross ||
    (Array.isArray(relationship.waypoints) && relationship.waypoints.length));
}

/** Puts a connector the user has dragged back onto the route the canvas would give it. */
function straightenConnector(relationshipId) {
  const relationship = relationshipById(relationshipId);
  if (!relationship) return;
  if (!handRouted(relationship)) return;

  mutate('straighten connector', () => {
    relationship.routeOffset = 0;
    relationship.routeOffsetCross = 0;

    // The corners the user moved by hand go with the offsets. Straightening is the one way back
    // from a route that has been shaped corner by corner, so leaving them would make the menu item
    // do nothing at all on the connectors most likely to need it.
    relationship.waypoints = [];
  });

  render();
  refreshInspector();
}

/** Puts a card the user has reordered by hand back under the ordinary column-order rules. */
function resetColumnOrder(tableId) {
  const table = tableById(tableId);
  if (!table || !(table.columnOrder || []).length) return;

  mutate('reset column order', () => { table.columnOrder = []; });
  invalidateSizes();
  render();
  refreshInspector();
}

function setFieldDetail(value) {
  mutate('field detail', () => { state.doc.settings.fieldDetail = value; });
  invalidateSizes();
  render();
  paintChrome();
}

/**
 * The zoom readout is a menu, not a reset button: a short list of the common levels gets there in
 * one click.
 */
function showZoomMenu(anchor) {
  const rect = anchor.getBoundingClientRect();
  const current = Math.round(state.view.zoom * 100);

  const levels = [25, 50, 75, 100, 125, 150, 200, 300];

  showContextMenu(rect.left, rect.top, [
    ...levels.map(level => ({
      text: level + '%',
      checked: current === level,
      run: () => zoomTo(level / 100)
    })),
    { separator: true },
    { text: 'Fit to view', run: () => fitToView() }
  ]);
}

function shortPath(path) {
  const parts = String(path).split(/[\\/]/);
  return parts.length <= 2 ? path : parts.slice(-2).join('\\');
}

// ------------------------------------------------------------ documents --

async function newDiagram() {
  if (!(await confirmDiscard())) return;

  // The document is not replaced here. Every path out of the picker that actually starts a new
  // diagram builds one itself, so cancelling leaves the current canvas exactly as it was.
  openSourcePicker({ mode: 'new' });
}

async function openDiagram(path, fromRecent) {
  if (!(await confirmDiscard())) return;

  let result;
  try {
    result = await withProgress('Opening diagram...',
      () => host.openDiagram(path || null, !!fromRecent));
  } catch (error) {
    // withProgress has shown the message. It says what went wrong and what to do about it -
    // missing file, locked file, wrong format, newer format - so nothing is added here.
    return;
  }

  if (!result || result.cancelled) return;

  if (!result.document || !Array.isArray(result.document.tables)) {
    toast('That file opened but contained no readable diagram.', 'error', { sticky: true });
    return;
  }

  setDocument(result.document, result.path);
  invalidateSizes();
  render();
  renderPanels();
  hideInspector();
  restoreView(result.document);

  const warnings = (result.notes || []).slice();

  if (result.environmentMismatch) {
    warnings.push(
      'This diagram was built against ' +
      ((result.document.source && result.document.source.organizationFriendlyName) || 'another environment') +
      '. You are connected somewhere else, so refresh will compare it against the connected environment.');
  }

  if (warnings.length) {
    toast('Opened ' + shortPath(result.path), 'warning', { list: warnings, timeout: 14000 });
  } else {
    toast('Opened ' + shortPath(result.path), 'success');
  }
}

async function saveDiagram(saveAs) {
  if (!state.doc.tables.length && !state.doc.annotations.length) {
    toast('There is nothing to save yet.', 'warning');
    return;
  }

  state.doc.view = { zoom: state.view.zoom, panX: state.view.panX, panY: state.view.panY };

  let result;
  try {
    result = await withProgress(
      'Saving...',
      () => host.saveDiagram(state.doc, state.path, saveAs),
      { quiet: true });
  } catch (error) {
    // One toast, not two: the host's message says exactly what went wrong, and the reassurance
    // that nothing was lost is the part it cannot know to add. The diagram is untouched in memory,
    // and untouched on disk too - the host writes to a temporary file and moves it into place.
    toast(
      (error && error.message ? error.message : 'The diagram could not be saved.') +
      '\n\nNothing was written, and your work is still here. Try Save as and pick another folder.',
      'error', { sticky: true });
    return;
  }

  if (!result || result.cancelled) return;

  state.path = result.path;

  // Through setDirty, not by writing state.dirty. setDirty is the only thing that tells the host,
  // which is what makes XrmToolBox drop its modified marker and stop prompting on close - and
  // because it early-returns when the value has not changed, setting the field by hand would also
  // stop every later edit in the session from notifying.
  setDirty(false);
  paintChrome();

  try {
    state.settings = await host.getSettings();
  } catch (error) { /* settings are a convenience, not a requirement */ }

  toast('Saved to ' + shortPath(result.path), 'success');
}

/**
 * The viewport an opened diagram should get.
 *
 * A .dvmd stores the pan and zoom it was saved at, and setDocument has already applied it. A file
 * that carries a view reopens where the user left it; one that does not - a v1 file, or one
 * hand-edited - opens at 100% like a new diagram rather than fitted to the window.
 */
function restoreView(document) {
  const view = (document && document.view) || {};
  const zoom = Number(view.zoom);
  const panX = Number(view.panX);
  const panY = Number(view.panY);

  // Zoom 1 with no pan at all is what the host's ViewState defaults to for a file that carries no
  // view - a version 1 file, or one written by hand. Honouring it would tuck the top-left corner
  // of the drawing under the command bar. A real saved view is never exactly this: even an
  // untouched new diagram starts at 60,90, and any pan or zoom since leaves a fraction behind.
  const carriesAView = zoom > 0 && Number.isFinite(panX) && Number.isFinite(panY) &&
                       !(zoom === 1 && panX === 0 && panY === 0);

  if (carriesAView) { render(); return; }
  resetView();
}

async function confirmDiscard() {
  if (!state.dirty) return true;
  return host.confirm('Unsaved changes',
    'This diagram has unsaved changes. Discard them?');
}

/** Whether there is a diagram to close - anything drawn, or a file the canvas came from. */
function hasContent() {
  return !!(state.doc.tables.length || state.doc.annotations.length || state.path);
}

/**
 * Puts the open diagram away and leaves an empty canvas.
 *
 * Not the same as New. New asks what the next diagram should be built from and opens the source
 * picker on top of the current one; Close leaves an empty canvas and asks no further questions.
 */
async function closeDiagram() {
  if (!hasContent() && !state.dirty) {
    toast('There is no diagram open.', 'info');
    return;
  }

  if (!(await confirmDiscard())) return;

  endDrawMode();
  setDocument(newDocument(), null);
  invalidateSizes();
  hideInspector();
  render();
  renderPanels();
  resetView();
  paintChrome();

  toast('Diagram closed. Use "Add existing tables" or "Propose new tables" to start another one, ' +
        'or the menu to open a saved one.',
    'info');
}

// ---------------------------------------------------------- annotations --

/** Collapses or expands a card from the context menu. By id, for the reason below. */
function toggleTableCollapsed(tableId) {
  const table = tableById(tableId);

  if (!table) {
    toast('That table is no longer on the diagram.', 'warning');
    return;
  }

  mutate('collapse', () => { table.collapsed = !table.collapsed; });
  render();
}

/**
 * Shows or hides a connector from the context menu. By id, for the reason below.
 */
function toggleConnectorHidden(relationshipId) {
  const relationship = relationshipById(relationshipId);

  if (!relationship) {
    toast('That relationship is no longer on the diagram.', 'warning');
    return;
  }

  mutate('hide', () => { relationship.hidden = !relationship.hidden; });

  render();
  renderPanels();
}

/**
 * Marks a relationship's status on the diagram.
 *
 * Takes an id and resolves it here, rather than taking the object the context menu captured when
 * it was built. Nothing dismisses that menu on a keystroke, so an undo between opening it and
 * choosing an item would leave the closure holding an object from the discarded document, and
 * syncProposedLookupColumn would read its id and then write to the live one.
 */
function setRelationshipStatus(relationshipId, status) {
  const relationship = relationshipById(relationshipId);

  if (!relationship) {
    toast('That relationship is no longer on the diagram.', 'warning');
    return;
  }

  const wasProposed = relationship.status === 'Proposed';

  mutate('relationship status', () => {
    relationship.status = status;

    // A proposed relationship owns the lookup column it created. Once it is no longer a proposal
    // that column is the diagram's, not the relationship's - left owned by a relationship the
    // editor refuses to open, it could be neither edited nor removed by any route the UI offers.
    syncProposedLookupColumn(relationship);
  });

  invalidateSizes();
  render();
  renderPanels();
  refreshInspector();

  toast((relationship.schemaName || 'The relationship') + ' marked ' + status.toLowerCase() +
    ' on this diagram. Dataverse is unchanged.' +
    (wasProposed && status !== 'Proposed'
      ? '\n\nIts lookup column is now an ordinary column on the card rather than part of the proposal.'
      : ''),
    'info');
}

/**
 * Arms one of the draw tools, so the next click on the canvas places the thing at that spot rather
 * than in the middle of the view.
 */
function startDrawing(tool) {
  startDrawMode(tool);
}

/**
 * Sends the cursor to the inspector's text box the moment a note or a text box is placed.
 *
 * The whole point of a text box is the text, and an empty one on the canvas with the cursor still
 * on the canvas is a box the user has to go and find a way into.
 */
function focusAnnotationText(annotation) {
  renderPanels();
  refreshInspector();

  if (!annotation || annotation.kind === 'arrow') return;

  const box = document.querySelector('#inspector-body textarea');
  if (box && box.focus) box.focus();
}

function addAnnotation(worldPoint, attachToId) {
  const point = worldPoint || centreOfCanvas();
  const annotation = newAnnotation('note', centreOn(point, NOTE_DEFAULT_SIZE), { attachedToId: attachToId });

  if (!annotation.attachedToId) {
    // Whatever is selected when the note is made is what it is about, table or relationship.
    const selectedTable = Array.from(state.selection.tables)[0];
    const selectedRelationship = Array.from(state.selection.relationships)[0];
    annotation.attachedToId = selectedTable || selectedRelationship || null;
  }

  mutate('add sticky note', () => { state.doc.annotations.push(annotation); });

  selectOnly('annotations', annotation.id);
  render();
  focusAnnotationText(annotation);
}

/**
 * Where a placed annotation's top-left corner goes, so the thing lands centred on the point that
 * was clicked rather than hanging down and to the right of it.
 *
 * The same maths interact.js uses for the armed draw tools, so "Sticky note here" from the canvas
 * menu and the Sticky note button on the toolbar put the note in the same place for the same click.
 */
function centreOn(point, width) {
  return {
    x: Math.round((point.x - width / 2) / 8) * 8,
    y: Math.round((point.y - 12) / 8) * 8
  };
}

/** A plain text box, placed straight away rather than by arming the tool. */
function addTextBox(worldPoint) {
  const point = worldPoint || centreOfCanvas();
  const annotation = newAnnotation('text', centreOn(point, 220));

  mutate('add text box', () => { state.doc.annotations.push(annotation); });

  selectOnly('annotations', annotation.id);
  render();
  focusAnnotationText(annotation);
}

function centreOfCanvas() {
  const box = $('#canvas').getBoundingClientRect();
  return toWorld(box.left + box.width / 2, box.top + box.height / 2);
}

// --------------------------------------------------------- context menu --

function showCanvasMenu(event, hit, worldPoint) {
  if (!hit) {
    const emphasised = state.doc.tables.filter(t => t.highlight).length +
                       state.doc.relationships.filter(r => r.highlight).length;

    showContextMenu(event.clientX, event.clientY, [
      { text: 'Add existing tables...', run: () => openSourcePicker({ mode: state.doc.tables.length ? 'add' : 'new' }) },
      { text: 'Explore relationships...', run: () => openExplorer() },
      { text: 'Cascade impact...', run: () => openCascadeAnalysis() },
      { text: 'Propose a change...', run: () => openProposeHub(worldPoint) },
      { separator: true },
      { label: 'Draw' },
      { text: 'Sticky note here', run: () => addAnnotation(worldPoint) },
      { text: 'Text box here', run: () => addTextBox(worldPoint) },
      { text: 'Arrow - drag on the canvas', run: () => startDrawing('arrow') },
      { separator: true },
      { text: 'Fit to view', run: () => fitToView() },
      { text: 'Reset zoom', run: () => resetZoom() },
      {
        text: 'Clear highlight',
        disabled: !state.highlightPath,
        run: () => { state.highlightPath = null; clearSelection(); render(); refreshInspector(); }
      },
      // Distinct from the item above, which only drops the transient path highlight; this one
      // removes the emphasis colours.
      {
        text: 'Remove all emphasis colours' + (emphasised ? ' (' + emphasised + ')' : ''),
        disabled: !emphasised,
        run: () => {
          mutate('clear emphasis', () => {
            state.doc.tables.forEach(t => { t.highlight = null; });
            state.doc.relationships.forEach(r => { r.highlight = null; });
          });
          render();
          refreshInspector();
        }
      }
    ]);
    return;
  }

  if (hit.kind === 'table') {
    const table = tableById(hit.id);
    if (!table) return;

    // The items below capture an id, not the table object, for the reason setRelationshipStatus
    // documents: a menu item runs after the click that opened it, and by then the document may
    // have been replaced. A captured object then belongs to a document nothing is drawing, so the
    // item quietly edits a discarded diagram and marks the live one dirty.
    const tableId = table.id;

    showContextMenu(event.clientX, event.clientY, [
      { label: table.displayName || table.logicalName },
      { text: table.collapsed ? 'Expand card' : 'Collapse card',
        run: () => toggleTableCollapsed(tableId) },
      { text: 'Highlight connections', run: () => {
        import('./state.js').then(module => {
          if (!tableById(tableId)) return;
          state.highlightPath = module.neighbourhood(tableId);
          render();
        });
      }},
      table.logicalName && table.status !== 'Proposed'
        ? {
            text: 'Explore from this table...',
            run: () => openExplorer(table.logicalName)
          }
        : null,
      table.logicalName && table.status !== 'Proposed'
        ? {
            text: 'What does deleting one of these take with it?...',
            run: () => openCascadeAnalysis(table.logicalName)
          }
        : null,
      { text: 'Add a sticky note about this table',
        run: () => {
          const current = tableById(tableId);
          if (current) addAnnotation({ x: current.x, y: current.y - 200 });
        } },

      // The way back from dragging a row. A hand-made order takes precedence over both the Column
      // order setting and the key float, so this returns the card to following Display settings.
      // Offered only when there is an order to reset, so it does not read as a command that does
      // nothing.
      (table.columnOrder || []).length
        ? { text: 'Reset column order on this card', run: () => resetColumnOrder(tableId) }
        : null,

      { separator: true },
      // Proposing a column or a relationship works on any table, existing ones included: a design
      // nearly always starts by adding something to what is already there.
      { text: 'Propose a column...', run: () => openProposedColumnEditor(tableId) },
      {
        text: 'Propose a relationship from here...',
        disabled: state.doc.tables.length < 2,
        run: () => openProposedRelationshipEditor({ fromTableId: tableId })
      },
      {
        text: 'Draw a relationship to...',
        disabled: state.doc.tables.length < 2,
        run: () => startConnectMode(tableId)
      },
      table.status !== 'Existing'
        ? { text: 'Edit this table design...', run: () => openProposedTableEditor(tableId) }
        : null,
      { separator: true },
      { label: 'Status on this diagram' },
      { text: 'Mark as proposed', run: () => setTableStatus(tableId, 'Proposed') },
      { text: 'Mark as external', run: () => setTableStatus(tableId, 'External') },
      { text: 'Mark as deprecated', run: () => setTableStatus(tableId, 'Deprecated') },
      { text: 'Mark as existing', run: () => setTableStatus(tableId, 'Existing') },
      { separator: true },
      { text: 'Remove from diagram', danger: true, run: () => {
        if (!tableById(tableId)) return;
        mutate('remove table', () => removeTable(tableId));
        clearSelection();
        render();
        renderPanels();
        refreshInspector();
      }}
    ].filter(Boolean));
    return;
  }

  if (hit.kind === 'relationship') {
    const relationship = relationshipById(hit.id);
    if (!relationship) return;

    // An id, not the connector object, for the same reason as the table menu above.
    const relationshipId = relationship.id;

    // Worked out once, here, rather than in the menu item's own closure: by the time that runs the
    // event is long gone and the route may have been redrawn, and asking twice is two chances to
    // get two different answers.
    const bend = bendUnderPointer(event, relationshipId);

    showContextMenu(event.clientX, event.clientY, [
      { label: relationship.schemaName || 'Relationship' },
      { text: relationship.hidden ? 'Show connector' : 'Hide connector',
        run: () => toggleConnectorHidden(relationshipId) },
      relationship.status === 'Proposed'
        ? { text: 'Edit this proposed relationship...',
            run: () => openProposedRelationshipEditor({ relationshipId }) }
        : null,
      { text: 'Add a sticky note about this relationship',
        run: () => addAnnotation(null, relationshipId) },

      // Right-clicked on one of the corner handles, and that bend can go. Offered on the answer
      // rather than always, so it never appears to do nothing: a line leaving one card's side and
      // arriving at another's at a different height has to turn twice, and taking one of those two
      // out only puts it straight back somewhere else.
      bend !== null
        ? { text: 'Remove this bend', run: () => removeBend(relationshipId, bend) }
        : null,

      // The way back from dragging a connector, as with the card's column order: a route can be
      // dragged into a shape whose offsets are no longer visible - a pair of cards restacked since,
      // or a sideways drag on a line that is still dead straight - and this straightens it again.
      handRouted(relationship)
        ? { text: 'Straighten this connector', run: () => straightenConnector(relationshipId) }
        : null,

      { separator: true },
      { label: 'Status on this diagram' },
      { text: 'Mark as deprecated', run: () => setRelationshipStatus(relationshipId, 'Deprecated') },
      { text: 'Mark as existing', run: () => setRelationshipStatus(relationshipId, 'Existing') },
      { separator: true },
      { text: 'Remove from diagram', danger: true, run: () => {
        if (!relationshipById(relationshipId)) return;
        mutate('remove relationship', () => removeRelationship(relationshipId));
        clearSelection();
        render();
        renderPanels();
        refreshInspector();
      }}
    ].filter(Boolean));
    return;
  }

  const annotation = (state.doc.annotations || []).find(entry => entry.id === hit.id);
  const what = annotation && annotation.kind === 'arrow' ? 'arrow'
    : annotation && annotation.kind === 'text' ? 'text box'
    : 'sticky note';

  // The id, not the object: the menu outlives the document it was opened on, and every item here
  // has to re-resolve, as in the table and connector branches - and the value written has to come
  // from the re-resolved object too.
  const annotationId = hit.id;
  const behind = annotationBehind(annotation);

  showContextMenu(event.clientX, event.clientY, [
    {
      text: behind ? 'Bring in front of the model' : 'Send behind the model',
      run: () => {
        const target = (state.doc.annotations || []).find(entry => entry.id === annotationId);
        if (!target) return;

        mutate('annotation depth', () => { target.behind = !annotationBehind(target); });
        render();
        refreshInspector();
      }
    },
    { separator: true },
    { text: 'Delete this ' + what, danger: true, run: () => {
      // Gone already - the document may have been replaced since the menu opened. Returns without
      // pushing an undo entry or marking the diagram dirty.
      if (!(state.doc.annotations || []).some(entry => entry.id === hit.id)) return;
      mutate('delete ' + what, () => removeAnnotation(hit.id));
      clearSelection();
      render();
      renderPanels();
      refreshInspector();
    }}
  ]);
}

function openEditorFor(hit) {
  if (hit.kind === 'table') {
    const table = tableById(hit.id);
    if (table && table.status !== 'Existing') openProposedTableEditor(table.id);
    else refreshInspector();
    return;
  }

  refreshInspector();
}

// ----------------------------------------------------------- host events --

function wireHostEvents() {
  on('progress', payload => {
    if (!payload) return;
    updateProgress(payload.message, payload.percent);
  });

  // Not hideProgress(true). The host raises this in the finally of every request, so the first of
  // two sequential calls would take down the overlay belonging to the second one. See
  // hostProgressDone.
  on('progress.done', () => hostProgressDone());

  on('connection.changed', payload => {
    state.connection = payload || { connected: false };
    invalidateCatalogue();
    paintChrome();
    refreshSourcePicker();

    if (state.connection.connected) {
      toast('Connected to ' + (state.connection.organizationFriendlyName || state.connection.host) + '.', 'success');
    }
  });

  on('document.open', payload => {
    if (!payload || !payload.document) return;
    setDocument(payload.document, payload.path);
    invalidateSizes();
    render();
    renderPanels();
    restoreView(payload.document);
  });

  on('command', payload => {
    if (payload && payload.name) runCommand(payload.name);
  });

  window.addEventListener('dmd:add-annotation', () => addAnnotation());
  window.addEventListener('dmd:refresh-inspector', () => refreshInspector());

  // The inspector offers "name this colour" beside its swatches, but the dialog lives here with
  // the legend it feeds. An event rather than an import, for the same reason proposed.js raises
  // dmd:refresh-inspector instead of importing the inspector: the two would otherwise form a cycle.
  window.addEventListener('dmd:name-colour', event => {
    const colour = event && event.detail && event.detail.colour;
    if (colour) renameEmphasis(colour);
  });

  window.addEventListener('dmd:open-diagram', event => {
    closeModal();
    const detail = (event && event.detail) || {};
    openDiagram(detail.path || null, !!detail.fromRecent);
  });
  window.addEventListener('dmd:close-modal', () => closeModal());
}

function wireGlobalShortcuts() {
  window.addEventListener('keydown', event => {
    const ctrl = event.ctrlKey || event.metaKey;
    if (!ctrl) return;

    const key = event.key.toLowerCase();

    // Save is the one shortcut that runs wherever focus is. It clashes with nothing a text field
    // does natively, and handing it back to the embedded browser would put that browser's own
    // "save page" dialog on screen instead.
    if (key === 's') { event.preventDefault(); saveDiagram(event.shiftKey); return; }

    // Everything below acts on the canvas behind whatever currently has focus, so neither a text
    // field nor an open dialog should reach it: Ctrl+Z in a text box is the box's own undo, and
    // Ctrl+O must not replace the document while a dialog is still editing it.
    if (isTypingTarget(event.target) || isModalOpen()) return;

    if (key === 'o') { event.preventDefault(); openDiagram(); return; }
    if (key === 'e') { event.preventDefault(); openExportDialog(); return; }
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      stepHistory(undo);
      return;
    }
    if (key === 'y' || (key === 'z' && event.shiftKey)) {
      event.preventDefault();
      stepHistory(redo);
      return;
    }
    if (key === '0') { event.preventDefault(); resetZoom(); return; }
    if (key === 'f') { event.preventDefault(); $('#panel-search').focus(); }
  });

  // The legend is placed in window coordinates, so a smaller window has to be able to pull it
  // back into view - it is clamped on every paint rather than when it is stored, so nothing about
  // where the user put it is lost when the window grows again.
  window.addEventListener('resize', () => { render(); layoutCommandBar(); applyLegendPosition(); });
}

// ----------------------------------------------------------------- about --

function showAbout() {
  const info = appInfo || {};

  // Asked for before the body is built, so the version line can start out saying it is looking
  // rather than saying it does not know. The dialog itself never waits on it.
  const retry = appInfoRetry();

  openModal({
    title: 'About',
    width: 500,
    padded: true,
    body: () => el('div', { style: { lineHeight: '1.6' } }, [
      // 256px artwork drawn at 88, rather than 128px artwork drawn at 56. Which of the two files
      // is used depends on the theme behind it.
      el('div', { class: 'guide-head', style: { marginBottom: '16px' } }, [
        el('img', { class: 'guide-logo', src: logoSrc(256), alt: 'Oliver4' }),
        el('div', {}, [
          el('div', { class: 'brand-eyebrow', text: 'OLIVER4' }),
          productName(info.toolName),
          versionLine(info, retry)
        ])
      ]),

      el('p', { text: 'Explore, design and document a Dataverse data model from inside XrmToolBox.' }),
      el('p', {}, [
        el('strong', { text: 'This tool only reads metadata. ' }),
        'Nothing it does changes the connected environment. Removing an object from a diagram, ' +
        'marking it deprecated or designing a proposed table are all diagram-level actions.'
      ]),
      el('p', { class: 'small muted' },
        'Diagrams are saved as .dvmd files - plain JSON, so they can go into source control ' +
        'alongside the solution they describe.'),

      el('p', { class: 'small muted' },
        'Provided as is, without warranty. Not affiliated with or endorsed by Microsoft or ' +
        'XrmToolBox. Microsoft, Dataverse and Dynamics 365 are trademarks of Microsoft Corporation.'),

      el('div', {
        class: 'small muted',
        style: { marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--line)' }
      }, info.copyright || '© 2026 Oliver4 Data Model Designer')
    ]),
    footer: api => modalFooter(api, {
      primaryLabel: 'Close',
      hideCancel: true,
      onPrimary: () => api.close(null)
    })
  });
}
