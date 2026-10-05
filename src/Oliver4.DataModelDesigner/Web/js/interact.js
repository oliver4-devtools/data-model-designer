// Canvas interaction: pan, zoom, selection, dragging and the right-click menu.

import { $, clone } from './util.js';
import {
  state, mutate, tableById, relationshipById, annotationById, subscribe,
  clearSelection, selectOnly, toggleSelection, notify, removeTable, removeRelationship, removeAnnotation,
  newAnnotation, annotationKind
} from './state.js';
import { render, routeFor, MIN_NOTE_WIDTH, MIN_NOTE_HEIGHT } from './render.js';
import {
  measureTable, tableRect, distanceToPolyline, rectsIntersect, annotationRect, annotationBounds,
  documentBounds, stickyTilt, visibleColumns, cardOrderAfterMove, columnOrderKey, invalidateSizes,
  cornersWithout, METRICS
} from './geometry.js';

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3;

/** Zoom buttons and keyboard shortcuts move in whole 5% steps from 100%. */
const ZOOM_STEP = 0.05;

let canvas = null;
let host = null;
let onSelectionChange = () => {};
let onContextMenu = () => {};
let onOpenEditor = () => {};
let onConnect = () => {};
let onAnnotationPlaced = () => {};

const drag = {
  mode: null,
  startScreen: null,
  startWorld: null,
  origin: null,
  moved: false,
  spaceHeld: false,
  button: 0,
  routeId: null,
  routeAxis: 'x',
  routeCrossAxis: null,
  rowTableId: null,
  resizeId: null,
  pointerId: null
};

/** Set when a right-button drag panned the canvas, so the drag does not also open a menu. */
let suppressContextMenu = false;

/**
 * A contextmenu event that arrived while the right button was still down. Chromium fires
 * contextmenu on release under Windows and on press elsewhere, so the menu is always held until
 * the button comes up and it is clear whether the gesture was a click or a pan.
 */
let pendingMenu = null;

export function initInteractions(handlers) {
  canvas = document.getElementById('canvas');
  host = document.getElementById('canvas-host');

  onSelectionChange = handlers.onSelectionChange || onSelectionChange;
  onContextMenu = handlers.onContextMenu || onContextMenu;
  onOpenEditor = handlers.onOpenEditor || onOpenEditor;
  onConnect = handlers.onConnect || onConnect;
  onAnnotationPlaced = handlers.onAnnotationPlaced || onAnnotationPlaced;

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  // Not onPointerUp. A cancelled pointer is the gesture being taken away - the browser turning a
  // touch drag into a pan, the view losing the input - not the user finishing it, so the drag is
  // abandoned rather than committed.
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onCanvasContextMenu);
  canvas.addEventListener('dblclick', onDoubleClick);

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // Space held down is a modifier. If the window loses focus while it is held the keyup never
  // arrives, so blur releases it; otherwise a plain left-drag would go on panning instead of
  // drawing a marquee.
  window.addEventListener('blur', onWindowBlur);

  // Connect mode holds a table id from the current document. Opening another diagram while it is
  // armed would leave the banner naming a table that no longer exists, and the next click would
  // try to connect that ghost to whatever was clicked.
  subscribe(reason => {
    if (reason !== 'document-replacing') return;
    endConnectMode();
    endDrawMode();

    // Same reasoning: an open note names a table in the document being replaced.
    state.openNote = null;

    // And the drag in flight belongs to the document that has just gone. Dropped rather than put
    // back, because this notification is raised *after* the swap - every id in it now resolves
    // against the new document, or against nothing - and committing it would push an undo entry and
    // mark the new diagram dirty before the user has touched it.
    forgetDrag();
  });

  // Undo and redo replace the document with a clone, which is the same swap under another name.
  // The drag in flight is dropped so its release does not write the captured origin onto an object
  // from the new document, take its undo snapshot from that, and clear the redo stack.
  subscribe(reason => {
    if (reason === 'undo' || reason === 'redo') forgetDrag();
  });

  // A dialog is about to cover the canvas, so any mode waiting for the next click on that canvas
  // is over. The mode's banner is appended to the body after the modal root at the same z-index, so
  // left armed it would float over the dialog, and Escape would close the dialog rather than the mode.
  //
  // An event rather than ui.js importing this module: ui.js is the layer underneath, and the
  // dependency the other way round would make a cycle.
  window.addEventListener('dmd:modal-opened', () => {
    // Read before ending anything: endDrawMode clears pendingArrow itself, so testing it afterwards
    // would always be false and the half-drawn preview would stay painted on the canvas.
    const wasActive = isConnecting() || isDrawing() || !!state.pendingArrow || !!drag.mode;

    endConnectMode();
    endDrawMode();

    // A drag in flight is abandoned, not finished: abandonDrag puts back the live geometry it had
    // already written. This matters most for a rotation, because the drag *creates* an angle the note
    // did not have, and the draw.io export treats an explicit angle as a chosen one.
    abandonDrag();

    if (wasActive) render();
  });
}

// ------------------------------------------------------------ coordinates --

export function toWorld(clientX, clientY) {
  const box = canvas.getBoundingClientRect();
  return {
    x: (clientX - box.left - state.view.panX) / state.view.zoom,
    y: (clientY - box.top - state.view.panY) / state.view.zoom
  };
}

export function toScreen(worldX, worldY) {
  const box = canvas.getBoundingClientRect();
  return {
    x: worldX * state.view.zoom + state.view.panX + box.left,
    y: worldY * state.view.zoom + state.view.panY + box.top
  };
}

// -------------------------------------------------------------- hit test --

/**
 * The table whose card is under a screen point, ignoring whatever is painted on top of it.
 *
 * Only connect mode needs this: everywhere else the topmost thing is genuinely what was clicked.
 * Walked backwards so the last card drawn - the one on top where two overlap - wins, which is the
 * same answer the browser's own hit test would give.
 */
function tableUnder(event) {
  const world = toWorld(event.clientX, event.clientY);
  const tables = state.doc.tables;

  for (let i = tables.length - 1; i >= 0; i--) {
    const rect = tableRect(tables[i]);
    if (world.x >= rect.x && world.x <= rect.x + rect.width &&
        world.y >= rect.y && world.y <= rect.y + rect.height) {
      return tables[i].id;
    }
  }

  return null;
}

function hitTest(event) {
  const target = event.target.closest('[data-kind]');
  if (target) {
    return { kind: target.getAttribute('data-kind'), id: target.getAttribute('data-id') };
  }

  // Connectors are thin; check proximity as a fallback so near-misses still select.
  const world = toWorld(event.clientX, event.clientY);
  const threshold = 8 / state.view.zoom;

  for (const relationship of state.doc.relationships) {
    const route = routeFor(relationship.id);
    if (!route) continue;
    if (distanceToPolyline(world, route.points) <= threshold) {
      return { kind: 'relationship', id: relationship.id };
    }
  }

  return null;
}

/** Whether this pointer is the one that started the gesture in flight. See drag.pointerId. */
function ownsDrag(event) {
  if (!event || event.pointerId === undefined || drag.pointerId === null) return true;
  return event.pointerId === drag.pointerId;
}

/** A number a drag can safely start from. NaN and infinity both become zero. */
function usable(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * A connector's hand-placed corners, copied and cleaned, ready for a drag to work on.
 *
 * Copied because every one of these drags writes live and is put back by the commit in onPointerUp
 * or by abandonDrag, and handing either of those the array the document is holding would give it
 * nothing to put back. Cleaned by the same rule the router applies: a point that is not a pair of
 * finite numbers is not drawn, so it is not dragged either.
 */
function pinnedCopy(relationship) {
  const raw = Array.isArray(relationship.waypoints) ? relationship.waypoints : [];
  const points = [];

  for (const point of raw) {
    if (!point) continue;
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push({ x, y });
  }

  return points;
}

/** A fresh array of fresh points, for the same reason pinnedCopy copies. */
function clonePoints(points) {
  return (points || []).map(point => ({ x: point.x, y: point.y }));
}

/** Whether two sets of hand-placed corners are the same set. */
function samePinning(a, b) {
  if (a.length !== b.length) return false;
  return a.every((point, at) =>
    Math.abs(point.x - b[at].x) < 0.01 && Math.abs(point.y - b[at].y) < 0.01);
}

/**
 * What a drag on one corner of a connector has to know.
 *
 * The corners of the route *as it is drawn* - not the list the relationship is carrying, which may
 * be shorter, because the router turns whatever extra bends it needs to reach the placed ones once
 * the cards have moved. Baking the drawn line is what makes a drag a move rather than an addition:
 * the corners either side of the one being grabbed are in the list too, so moving a leg moves both
 * of its ends and the line gains nothing.
 */
function cornerDragOrigin(relationship, route, cornerIndex) {
  const corners = route.corners || [];
  const corner = corners[cornerIndex];
  if (!corner) return null;
  if (!corner.carryX && !corner.carryY) return null;

  return {
    previous: pinnedCopy(relationship),
    base: corners.map(entry => ({ x: entry.x, y: entry.y })),
    index: cornerIndex,
    carryX: corner.carryX,
    carryY: corner.carryY,
    start: { x: route.start.x, y: route.start.y },
    end: { x: route.end.x, y: route.end.y },

    // What Shift, and the connector's own right-click menu, do instead of moving it: take the bend
    // out. Null when the route cannot be drawn without a turn there, and then both say so by
    // doing nothing rather than by putting it straight back.
    removal: cornersWithout(relationship, route.fanIndex, route.fanCount, cornerIndex),

    offset: usable(relationship.routeOffset),
    cross: usable(relationship.routeOffsetCross)
  };
}

/**
 * The corners after one of them has been dragged: the two legs that meet at it move, and nothing
 * else does.
 *
 * Each axis is taken separately, because the two legs are. Moving along x carries the vertical leg
 * and leaves the horizontal one to stretch; moving along y does the opposite. A leg held at an
 * anchor does not move, and `carryX`/`carryY` are null for that axis - which is why a corner next
 * to a card slides one way only.
 */
function dragCornerTo(origin, worldDx, worldDy, snap) {
  const points = clonePoints(origin.base);
  const here = origin.base[origin.index];

  const move = (axis, carry, to) => {
    if (!carry) return;

    const moving = [origin.index].concat(carry).filter(at => points[at]);
    const target = clampLeg(origin, moving, axis, Math.round(to / snap) * snap);

    for (const at of moving) points[at][axis] = target;
  };

  move('x', origin.carryX, here.x + worldDx);
  move('y', origin.carryY, here.y + worldDy);

  return points;
}

/** The shortest a leg is allowed to get before it stops being a leg, in canvas units. */
const MIN_LEG = 12;

/** How far from a card a leg that has to be broken to move puts its new corner, in canvas units. */
const LEG_STEP = 20;

/**
 * Which leg of a drawn route a press landed on: the index of the point the leg starts at, or null
 * when the route has nothing to grab.
 */
function nearestLeg(points, world) {
  let best = null;
  let closest = Infinity;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];

    const run = Math.abs(a.x - b.x) > Math.abs(a.y - b.y) ? 'x' : 'y';
    const across = run === 'x' ? 'y' : 'x';
    if (Math.abs(a[run] - b[run]) < 0.01) continue;

    const low = Math.min(a[run], b[run]);
    const high = Math.max(a[run], b[run]);
    const on = Math.max(low, Math.min(high, world[run]));

    const distance = Math.hypot(on - world[run], a[across] - world[across]);
    if (distance < closest) { closest = distance; best = i; }
  }

  return best;
}

/**
 * The corners after the leg the drag grabbed has been moved across itself.
 *
 * The two legs either side run the other way, so they simply stretch - which is the whole of it
 * when both ends of the moved leg are corners. When an end is an *anchor* there is no leg there to
 * stretch: the anchor is sitting on the column the relationship points at and cannot travel, so the
 * route is broken just clear of the card and the new corner carries that end instead. That is the
 * one gesture on this canvas that adds a bend, and it is the gesture the bend is being asked for.
 *
 * Returns null when the leg cannot move - a straight run with a card at both ends of it.
 */
function dragLegTo(origin, worldDx, worldDy, snap) {
  const points = origin.points;
  const at = origin.leg;
  if (at === null || at < 0 || at + 1 >= points.length) return null;

  const a = points[at];
  const b = points[at + 1];

  // The leg runs one way and moves the other.
  const across = Math.abs(a.x - b.x) < 0.01 ? 'x' : 'y';
  const run = across === 'x' ? 'y' : 'x';
  const to = Math.round((a[across] + (across === 'x' ? worldDx : worldDy)) / snap) * snap;

  // The drag has travelled, but not far enough to move the leg anywhere. Breaking the route to put
  // it back where it already is would be an undo step that undid nothing and a connector carrying
  // corners nobody placed.
  if (Math.abs(to - a[across]) < 0.01) return null;

  const ahead = [];
  const behind = [];

  // An end that is one of the two anchors is broken rather than moved. The new corner stands clear
  // of the card by a step, or a third of the leg when the leg is shorter than that - the picture is
  // a step at the end of a run, and a step longer than the run it is on is not one.
  const step = Math.max(2, Math.min(LEG_STEP, Math.abs(b[run] - a[run]) / 3));

  let first;
  let second;

  if (at === 0) {
    const q = a[run] + (b[run] > a[run] ? step : -step);
    ahead.push({ x: a.x, y: a.y }, across === 'x' ? { x: a.x, y: q } : { x: q, y: a.y });
    first = across === 'x' ? { x: to, y: q } : { x: q, y: to };
  } else {
    for (let i = 0; i < at; i++) ahead.push({ x: points[i].x, y: points[i].y });
    first = across === 'x' ? { x: to, y: a.y } : { x: a.x, y: to };
  }

  if (at + 1 === points.length - 1) {
    const q = b[run] + (a[run] > b[run] ? step : -step);
    second = across === 'x' ? { x: to, y: q } : { x: q, y: to };
    behind.push(across === 'x' ? { x: b.x, y: q } : { x: q, y: b.y }, { x: b.x, y: b.y });
  } else {
    second = across === 'x' ? { x: to, y: b.y } : { x: b.x, y: to };
    for (let i = at + 2; i < points.length; i++) behind.push({ x: points[i].x, y: points[i].y });
  }

  // Interior points only: the two anchors belong to the cards, not to the list.
  return ahead.concat([first, second], behind).slice(1, -1);
}

/**
 * Keeps a leg being dragged clear of the card at the far end of the leg it is stretching.
 *
 * The leg that stretches is the one running the other way, and at one or both ends of the route
 * that leg finishes on an anchor. Dragged all the way onto the anchor's own coordinate it has no
 * length left, tidy drops it, and the two corners either side of it collapse into one with a card
 * at both ends - which can move neither leg, so it is given no handle and the connector the user
 * was in the middle of shaping loses every control it had.
 */
function clampLeg(origin, moving, axis, target) {
  let low = -Infinity;
  let high = Infinity;

  for (const at of moving) {
    for (const side of [{ point: at === 0 ? origin.start : null, from: -1 },
                        { point: at === origin.base.length - 1 ? origin.end : null, from: 1 }]) {
      if (!side.point) continue;

      // Only a leg lying *along* this axis is the one being stretched; one across it is the leg
      // being moved, and its far end is travelling too.
      const other = axis === 'x' ? 'y' : 'x';
      if (Math.abs(side.point[other] - origin.base[at][other]) >= 0.01) continue;

      const room = origin.base[at][axis] - side.point[axis];
      if (room > 0.01) low = Math.max(low, side.point[axis] + MIN_LEG);
      else if (room < -0.01) high = Math.min(high, side.point[axis] - MIN_LEG);
    }
  }

  return Math.max(low, Math.min(high, target));
}

/**
 * Writes the corners a drag has arrived at onto the connector.
 *
 * Both offsets go with them. The corners a drag pins are read off the *drawn* route, which already
 * has both offsets in it, so leaving them set would apply them to the manual route a second time;
 * and a Shift that puts the route back to automatic has to put the offsets back with it, or the
 * connector would snap to a shape it has never had.
 */
function applyCorners(relationship, points, offset, cross) {
  relationship.waypoints = clonePoints(points);
  relationship.routeOffset = offset;
  relationship.routeOffsetCross = cross;
}

/** A pointer taken away mid-gesture. Puts back whatever the drag had written and ends it. */
function onPointerCancel(event) {
  if (event && event.pointerId !== undefined) {
    try { canvas.releasePointerCapture(event.pointerId); } catch (error) { /* pointer already gone */ }
  }

  if (!drag.mode) return;

  abandonDrag();
  render();
}

/**
 * Puts the row being dragged wherever the pointer now is, live on the card.
 *
 * Live rather than on release because the card is the only feedback there is: the rows are drawn
 * where the order says they go, so watching them move *is* watching the drag. The original order is
 * held on the drag and put back by abandonDrag, and the commit in onPointerUp is the same
 * revert-then-mutate the connector drag uses, so the whole gesture is one undo step.
 */
function dragRowTo(event) {
  const table = tableById(drag.rowTableId);
  if (!table) return;

  const rows = visibleColumns(table);
  if (rows.length < 2) return;

  const from = rows.findIndex(column => column.id === drag.origin.columnId);
  if (from < 0) return;

  const rect = tableRect(table);
  const world = toWorld(event.clientX, event.clientY);
  const over = Math.floor((world.y - rect.y - METRICS.headerHeight) / METRICS.rowHeight);
  const to = Math.max(0, Math.min(rows.length - 1, over));

  if (to === from) return;

  const keys = rows.map(columnOrderKey);
  const moved = keys.splice(from, 1)[0];
  keys.splice(to, 0, moved);

  // No invalidateSizes. The card's order is part of what measureTable keys its cache on, so the
  // rows are re-measured because they are a different question, not because the cache was emptied -
  // and emptying it here would re-measure every card on the diagram each time the pointer crossed
  // a row boundary.
  table.columnOrder = cardOrderAfterMove(table, keys);
  render();
}

// --------------------------------------------------------------- pointer --

function onPointerDown(event) {
  // A gesture already in flight, and a second button or a second finger going down on top of it.
  // Everything below overwrites the drag state, and the commit in onPointerUp is keyed on the mode
  // it finds there, so the first drag would never reach its commit and the geometry it had written
  // live would stay on the object with no undo entry. It is abandoned and put back first.
  if (drag.mode) { abandonDrag(); render(); }

  canvas.setPointerCapture(event.pointerId);

  // Cleared where the gesture that sets it begins, not where it is consumed. It is set on the way
  // up from a right-button pan and cleared inside the canvas contextmenu handler, so any pan that
  // never produces a contextmenu on the canvas - Alt+Tab mid-drag, or releasing over a side panel,
  // where pointer capture keeps pointerup here while contextmenu goes to the element under the
  // cursor - would otherwise leave it armed and swallow the next right-click.
  suppressContextMenu = false;

  drag.startScreen = { x: event.clientX, y: event.clientY };
  drag.startWorld = toWorld(event.clientX, event.clientY);
  drag.moved = false;
  drag.button = event.button;

  // Which pointer owns what follows. A second finger - or a stylus alongside a mouse - starts its
  // own gesture above, and the first one's release would otherwise arrive here as the end of that
  // gesture, ending the mode and releasing the capture for the wrong pointer. The legend drag is
  // guarded the same way.
  drag.pointerId = event.pointerId === undefined ? null : event.pointerId;

  // A draw tool is armed, so the next click on the canvas means "put one here" rather than
  // "select whatever is under the pointer". Checked before everything else for the same reason
  // connect mode is: while a mode is on, the ordinary meaning of a click is suspended, and a mode
  // that only half applies is worse than no mode at all.
  if (isDrawing() && event.button === 0) {
    const tool = state.draw.tool;

    if (tool === 'arrow') {
      drag.mode = 'draw-arrow';
      drag.origin = { ink: state.draw.ink || null };
      state.pendingArrow = {
        x: drag.startWorld.x, y: drag.startWorld.y, dx: 0, dy: 0, ink: drag.origin.ink
      };
      render();
      return;
    }

    drag.mode = null;
    endDrawMode();
    placeAnnotation(tool, drag.startWorld);
    return;
  }

  // Right-click gets out of a draw mode rather than opening a menu inside it, and then falls
  // through to the ordinary right-button pan below.
  if (isDrawing() && event.button === 2) endDrawMode();

  // The grab handles on the ends of a selected arrow. Before the resize grip below, which looks
  // for a different attribute, and before the hit test, which would otherwise treat the handle as
  // a click on the arrow itself and start a move.
  //
  // Not while connect mode is armed, for the same reason the NOTE tag is not: an annotation can be
  // drawn in front of the cards, so "click the other table" can land on a handle belonging to
  // something selected earlier - and reshaping an arrow instead of drawing the relationship would
  // leave the banner up with nothing to show for the click.
  if (event.button === 0 && event.target.closest && !isConnecting()) {
    const endHandle = event.target.closest('[data-arrow-end]');
    const startHandle = endHandle ? null : event.target.closest('[data-arrow-start]');
    const handle = endHandle || startHandle;

    if (handle) {
      const annotation = annotationById(handle.getAttribute('data-id'));

      if (annotation) {
        drag.mode = endHandle ? 'arrow-end' : 'arrow-start';
        drag.resizeId = annotation.id;
        drag.origin = {
          x: annotation.x, y: annotation.y,
          dx: Number(annotation.dx) || 0, dy: Number(annotation.dy) || 0
        };
        return;
      }
    }
  }

  // The NOTE tag on a card, and the close cross on the note it opens. Both are inside groups that
  // would otherwise be hit-tested as the table or as empty canvas, so they are checked first and
  // the gesture ends here: no selection change, no drag, and clicking the tag again closes it.
  //
  // Not while connect mode is armed. The tag sits in the right-hand end of a card's header, so
  // "click the other table to draw a relationship to it" would open a note instead whenever the
  // click happened to land on it - leaving the banner up, no connector drawn, and the mode still
  // armed for the next click somewhere else.
  if (event.button === 0 && event.target.closest && !isConnecting()) {
    const closer = event.target.closest('[data-note-close]');
    if (closer) {
      drag.mode = null;
      state.openNote = null;
      render();
      return;
    }

    const tag = event.target.closest('[data-note-for]');
    if (tag) {
      drag.mode = null;
      const id = tag.getAttribute('data-note-for');
      state.openNote = state.openNote === id ? null : id;
      render();
      return;
    }
  }

  // The rotation knob above a selected sticky note. Checked with the other controls drawn on the
  // selection rather than after the hit test, because it stands over whatever is behind the note.
  // Not while connecting, for the reason above.
  if (event.button === 0 && !isConnecting()) {
    const knob = event.target.closest ? event.target.closest('[data-rotate]') : null;
    if (knob) {
      const annotation = annotationById(knob.getAttribute('data-id'));
      if (annotation) {
        selectOnly('annotations', annotation.id);
        render();
        onSelectionChange();

        // The note turns about the centre of its placed rectangle, which is what the renderer
        // rotates it about, so that is where both angles are measured from.
        const rect = annotationRect(annotation);
        const centre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };

        drag.mode = 'rotate';
        drag.resizeId = annotation.id;
        drag.origin = {
          // Where the note is standing now, derived slant included, so grabbing the knob does not
          // snap an untouched note upright before the drag has moved anywhere.
          tilt: stickyTilt(annotation),

          // ...but whether that angle was ever *written* is a different question. If it was not,
          // an abandoned drag has to leave the note with no tilt of its own rather than freezing
          // the derived one into the file - see the commit in onPointerUp.
          hadTilt: hasExplicitTilt(annotation),
          centre,
          pointer: angleAt(centre, drag.startWorld)
        };

        return;
      }
    }
  }

  // The corner grip on a note is checked before anything else, otherwise the note under it wins
  // the hit test and the gesture becomes a move. Not while connecting, for the reason above.
  if (event.button === 0 && !isConnecting()) {
    const grip = event.target.closest ? event.target.closest('[data-resize]') : null;
    if (grip) {
      const annotation = annotationById(grip.getAttribute('data-id'));
      if (annotation) {
        selectOnly('annotations', annotation.id);
        render();
        onSelectionChange();

        // Seeded from annotationRect rather than from the raw fields, so a note with no size on it
        // - a hand-edited or pre-1.6.0 file - does not jump to a different size the moment the
        // grip is grabbed.
        const size = annotationRect(annotation);
        const tilt = drawnTilt(annotation);
        const centre = { x: size.x + size.width / 2, y: size.y + size.height / 2 };

        drag.mode = 'resize';
        drag.resizeId = annotation.id;
        drag.origin = {
          width: size.width, height: size.height,
          x: annotation.x, y: annotation.y,
          tilt,

          // The corner diagonally opposite the grip, in world coordinates. A note is drawn rotated
          // about the centre of its own rectangle, so growing it moves that centre and drags the
          // far corner along with it; holding this point still is what makes the grip follow the
          // pointer instead of half of it. At no tilt the arithmetic below reduces to the anchor
          // being x,y, with neither of them moving.
          anchor: rotateAbout({ x: size.x, y: size.y }, centre, tilt)
        };

        return;
      }
    }
  }

  // The handles on the corners of a selected connector. Checked before the hit test for the same
  // reason as the arrow handles: the hit test finds the connector underneath and starts a drag of
  // the whole route, which is the gesture this one exists to be an alternative to. Not while
  // connecting, for the reason above.
  //
  // Shift is read on the way down as well as during the move, which it is not for anything the hit
  // test finds: a handle is its own target, so Shift here cannot be the toggle-the-selection
  // modifier that a Shift-press on the line itself is. A Shift or Ctrl press that turns out to be a
  // *click* is still a selection gesture though, and the release deals with that, so Shift-clicking
  // a connector on one of its bends still toggles it in the selection.
  if (event.button === 0 && !isConnecting()) {
    const handle = event.target.closest ? event.target.closest('[data-corner]') : null;

    if (handle) {
      const relationship = relationshipById(handle.getAttribute('data-id'));
      const route = relationship ? routeFor(relationship.id) : null;
      const origin = route ? cornerDragOrigin(relationship, route, Number(handle.getAttribute('data-corner'))) : null;

      if (origin) {
        drag.mode = 'corner';
        drag.routeId = relationship.id;
        drag.origin = origin;
        return;
      }
    }
  }

  // The grips down the outside of a selected card's left edge, which put its rows in a different
  // order. Checked with the other controls drawn on a selection rather than after the hit test:
  // they stand outside the card, so the hit test would find nothing there and start a marquee
  // across the canvas instead. Not while connecting, for the reason above.
  if (event.button === 0 && !isConnecting()) {
    const grip = event.target.closest ? event.target.closest('[data-row-grip]') : null;

    if (grip) {
      const table = tableById(grip.getAttribute('data-table'));
      const columnId = grip.getAttribute('data-id');

      // The grip was drawn for a row the card was showing at the time. Anything that repaints the
      // card between the draw and the press can take that row away, and reordering against a row
      // that is no longer there would write an order describing a card nobody can see.
      if (table && visibleColumns(table).some(column => column.id === columnId)) {
        drag.mode = 'row';
        drag.rowTableId = table.id;
        drag.origin = {
          columnId,
          // Empty rather than null for a card that had no order: both mean the same thing to every
          // reader, and null is the one of the two that ends up written into the saved file.
          order: Array.isArray(table.columnOrder) ? table.columnOrder.slice() : []
        };
        return;
      }
    }
  }

  // Right-button drag pans the canvas. A right-click that does not move still opens the menu,
  // which is why the menu is only suppressed once the pointer has actually travelled.
  if (event.button === 2) {
    drag.mode = 'pan';
    drag.origin = { panX: state.view.panX, panY: state.view.panY };
    canvas.classList.add('is-panning');
    return;
  }

  const hit = hitTest(event);

  // Connect mode: armed from a table's menu, then the next card clicked becomes the other end.
  // A mode rather than a modifier-drag, because Alt-drag and Ctrl-drag already mean pan and
  // fine-nudge.
  if (state.connect && state.connect.fromTableId) {
    if (event.button !== 0) return;

    // What the pointer landed on may not be what the user was pointing at. An annotation is drawn
    // in front of the cards by default, so a note sitting on a table - which is exactly where a note
    // about that table goes - takes the click. The card under the pointer is used instead, so the
    // click still draws the relationship rather than selecting and dragging the note.
    const target = hit && hit.kind === 'table' ? hit.id : tableUnder(event);

    if (target && target !== state.connect.fromTableId) {
      const from = state.connect.fromTableId;
      endConnectMode();
      onConnect(from, target);
      return;
    }

    // Empty canvas gets out of the mode, which is the only cheap way out of it. Anything else -
    // a connector, an annotation with no card under it, the source card itself - is left alone
    // rather than being selected or dragged, so the next click can still be the other end.
    if (!hit) {
      endConnectMode();
      return;
    }

    if (!target) return;
  }

  const isPanGesture = event.button === 1 || drag.spaceHeld || (!hit && event.altKey);

  if (isPanGesture) {
    drag.mode = 'pan';
    drag.origin = { panX: state.view.panX, panY: state.view.panY };
    canvas.classList.add('is-panning');
    return;
  }

  if (!hit) {
    drag.mode = 'marquee';
    if (!event.shiftKey && !event.ctrlKey) {
      clearSelection();
      render();
      onSelectionChange();
    }
    return;
  }

  const kind = hit.kind === 'table' ? 'tables'
    : hit.kind === 'relationship' ? 'relationships' : 'annotations';

  if (event.shiftKey || event.ctrlKey) {
    toggleSelection(kind, hit.id);
  } else if (!state.selection[kind].has(hit.id)) {
    selectOnly(kind, hit.id);
  }

  render();
  onSelectionChange();

  if (hit.kind === 'relationship') {
    const relationship = relationshipById(hit.id);
    const route = routeFor(hit.id);

    if (!relationship || !route) { drag.mode = null; return; }

    drag.mode = 'route';
    drag.routeId = hit.id;
    drag.routeAxis = route.offsetAxis === 'y' ? 'y' : 'x';

    // The other axis, when this shape has one. A connector running down the outside of two stacked
    // cards does not: its two arms are at the rows they point at, and the lane is the only part of
    // it that can move. Left null, the drag writes nothing across rather than a number that draws
    // nothing and then has to be explained.
    drag.routeCrossAxis = route.crossAxis === 'x' || route.crossAxis === 'y' ? route.crossAxis : null;

    // The same guard routeRelationship applies. `Number(x) || 0` turns NaN into zero and leaves
    // infinity alone, and an infinite origin means every move writes infinity back: the connector
    // draws at zero - the router guards it - and can never be dragged to a value that is not
    // infinite. The host clears both on the way in from a file; a document pushed over the bridge
    // does not pass through that.
    drag.origin = {
      offset: usable(relationship.routeOffset),
      cross: usable(relationship.routeOffsetCross),

      // A route the user has already shaped by hand has no offset to move - the shape is the
      // corners - so what a drag on it moves is the leg it was grabbed by.
      waypoints: pinnedCopy(relationship),
      points: route.points.map(point => ({ x: point.x, y: point.y })),
      leg: nearestLeg(route.points, drag.startWorld)
    };
    return;
  }

  drag.mode = 'move';
  drag.origin = captureMovablePositions();
}

/**
 * Ends the drag in flight and forgets it, without putting anything back.
 *
 * For the routes where the document itself has been replaced: the ids the drag is holding no
 * longer name anything in it, so there is nothing to revert to and reverting would write into the
 * wrong diagram.
 */
function forgetDrag() {
  drag.mode = null;
  drag.moved = false;
  drag.origin = null;
  drag.routeId = null;
  drag.rowTableId = null;
  drag.resizeId = null;

  // The arrow that was being dragged out belongs to the gesture, not to the document: nothing has
  // been committed, and renderOverlay goes on painting it until it is taken away.
  state.pendingArrow = null;

  clearDragChrome('marquee');
}

/**
 * The two things a drag paints outside the document: the marquee rectangle and the pan cursor.
 *
 * Neither is cleared by a redraw - the marquee is a sibling of the whole viewport rather than
 * something inside a layer - so a gesture that ends anywhere other than onPointerUp leaves both
 * standing. That is a rectangle drawn across the canvas until the next marquee finishes, and a
 * grabbing cursor that outlives the pan.
 */
function clearDragChrome(mode) {
  if (canvas) canvas.classList.remove('is-panning');
  if (mode === 'marquee') hideMarquee();
}

/**
 * Puts back whatever the drag in flight had already written, and ends it.
 *
 * Only the modes that write into the *document* as they go need reverting; a pan, a marquee or a
 * gesture that never moved has nothing in the file to put back - but both of those still leave
 * something painted on screen, which clearDragChrome takes care of for every mode.
 */
function abandonDrag() {
  const mode = drag.mode;
  drag.mode = null;

  clearDragChrome(mode);

  if (!mode || !drag.moved) { drag.resizeId = null; return; }

  // The one gesture this keeps rather than puts back.
  //
  // A pan is navigation, not an edit: nothing in the diagram changed, and snapping the canvas back
  // would lose where the user is looking. The *document* only learns where the view is in
  // onPointerUp, which an abandoned gesture never reaches, so the view is written to it here and the
  // saved view matches the one on screen.
  if (mode === 'pan') {
    state.doc.view = { zoom: state.view.zoom, panX: state.view.panX, panY: state.view.panY };
    return;
  }

  // An arrow being dragged out is a draw mode as well as a drag. endDrawMode puts both away - the
  // pending arrow renderOverlay is painting, the armed tool and its banner.
  if (mode === 'draw-arrow') {
    endDrawMode();
    return;
  }

  if (mode === 'route' || mode === 'corner') {
    const relationship = relationshipById(drag.routeId);
    const was = mode === 'corner' ? drag.origin.previous : drag.origin.waypoints;

    if (relationship) {
      relationship.routeOffset = drag.origin.offset;
      relationship.routeOffsetCross = drag.origin.cross;

      // Only when there is something to put back, or something to take away. An ordinary offset
      // drag on a connector with no corners should leave it without the property, not with an
      // empty list the gesture had nothing to do with.
      if (was.length || (relationship.waypoints || []).length) {
        relationship.waypoints = clonePoints(was);
      }
    }

    drag.routeId = null;
    return;
  }

  if (mode === 'row') {
    const table = tableById(drag.rowTableId);
    drag.rowTableId = null;
    if (table) {
      table.columnOrder = drag.origin.order;
      render();
    }
    return;
  }

  if (mode === 'move') {
    for (const entry of drag.origin || []) {
      const target = entry.kind === 'table' ? tableById(entry.id) : annotationById(entry.id);
      if (target) { target.x = entry.x; target.y = entry.y; }
    }
    return;
  }

  const annotation = annotationById(drag.resizeId);
  drag.resizeId = null;
  if (!annotation) return;

  if (mode === 'resize') {
    Object.assign(annotation, {
      width: drag.origin.width, height: drag.origin.height,
      x: drag.origin.x, y: drag.origin.y
    });
  } else if (mode === 'rotate') {
    if (drag.origin.hadTilt) annotation.tilt = drag.origin.tilt;
    else delete annotation.tilt;
  } else if (mode === 'arrow-end' || mode === 'arrow-start') {
    Object.assign(annotation, {
      x: drag.origin.x, y: drag.origin.y, dx: drag.origin.dx, dy: drag.origin.dy
    });
  }
}

/**
 * The frame a resize drag works in: the angle the user has *chosen* for this annotation, or none.
 *
 * Only a sticky note is ever turned, and only one turned by hand counts. The slight slant an
 * untouched note is drawn with is decoration - derived from its id so that a wall of notes does
 * not look like a grid - and nobody dragging the corner of one is thinking in its frame. Honouring
 * it here would also make the arithmetic depend on which id the note happened to be given: at four
 * degrees a 64-unit drag picks up five units of the other axis, which is enough to cross the
 * eight-unit snap, so two notes would answer the same gesture differently.
 *
  * A note turned by hand is the opposite case. Its axes are where the user put them, so screen
  * travel has to be turned into that frame, or adding it to a width measured along those axes would
  * grow the note away from the pointer.
 */
function drawnTilt(annotation) {
  return annotationKind(annotation) === 'note' && hasExplicitTilt(annotation)
    ? stickyTilt(annotation)
    : 0;
}

/** A vector in world coordinates, expressed in the frame of something turned by `degrees`. */
function toLocal(x, y, degrees) {
  const radians = (degrees || 0) * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  return { x: x * cos + y * sin, y: -x * sin + y * cos };
}

/** A point moved by a vector given in the frame of something turned by `degrees`. */
function translate(point, vector, degrees) {
  const radians = (degrees || 0) * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  return {
    x: point.x + vector.x * cos - vector.y * sin,
    y: point.y + vector.x * sin + vector.y * cos
  };
}

/** A point turned about another point by `degrees`, the way the renderer turns a note. */
function rotateAbout(point, centre, degrees) {
  return translate(centre, { x: point.x - centre.x, y: point.y - centre.y }, degrees);
}

/**
 * Asks the inspector to redraw itself.
 *
  * A drag writes straight onto the annotation, so the panel beside it would otherwise keep whatever
  * it was built with - such as the Angle box and its list of angles. An event rather than an
  * import: inspector.js imports this module, and the dependency the other way round would make a
  * cycle.
 */
function refreshInspectorSoon() {
  window.dispatchEvent(new CustomEvent('dmd:refresh-inspector'));
}

/** Whether an annotation carries an angle of its own, as opposed to the one geometry.js derives. */
export function hasExplicitTilt(annotation) {
  return !!annotation && typeof annotation.tilt === 'number' && isFinite(annotation.tilt);
}

/** The angle from a centre point to another point, in degrees, positive clockwise. */
function angleAt(centre, point) {
  return Math.atan2(point.y - centre.y, point.x - centre.x) * 180 / Math.PI;
}

/**
 * An angle folded back into [-180, 180).
 *
  * Applied to the *change* as well as to the result: a drag that crosses the point where atan2
  * flips from 180 to -180 produces a delta of nearly 360 degrees, and without this the note would
  * spin the long way round in one frame.
 */
export function wrapDegrees(degrees) {
  const wrapped = ((degrees + 180) % 360 + 360) % 360 - 180;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

function captureMovablePositions() {
  const positions = [];

  for (const id of state.selection.tables) {
    const table = tableById(id);
    if (table) positions.push({ kind: 'table', id, x: table.x, y: table.y });
  }

  for (const id of state.selection.annotations) {
    const annotation = annotationById(id);
    if (annotation) positions.push({ kind: 'annotation', id, x: annotation.x, y: annotation.y });
  }

  return positions;
}

function onPointerMove(event) {
  if (!drag.mode) return;
  if (!ownsDrag(event)) return;

  const dx = event.clientX - drag.startScreen.x;
  const dy = event.clientY - drag.startScreen.y;

  if (!drag.moved && Math.hypot(dx, dy) < 3) return;
  drag.moved = true;

  if (drag.mode === 'pan') {
    state.view.panX = drag.origin.panX + dx;
    state.view.panY = drag.origin.panY + dy;
    render();
    return;
  }

  if (drag.mode === 'marquee') {
    drawMarquee(drag.startScreen, { x: event.clientX, y: event.clientY });
    return;
  }

  if (drag.mode === 'corner') {
    const relationship = relationshipById(drag.routeId);
    if (!relationship) return;

    if (event.shiftKey) {
      // Shift takes the bend out rather than moving it, which is the same thing the connector's
      // right-click menu offers - and, like the menu, it does nothing at all on a corner the route
      // cannot be drawn without.
      //
      // The corners left behind carry the whole shape, so the two offsets - which move the middle
      // of an *automatic* route - have nothing left to move and would be applied a second time the
      // moment anything cleared the corners. An empty list is the automatic route, and there they
      // are exactly what the user last dragged, so there they stay.
      const left = drag.origin.removal || drag.origin.previous;
      applyCorners(relationship, left,
        left.length ? 0 : drag.origin.offset,
        left.length ? 0 : drag.origin.cross);
    } else {
      // Snapped like a card is, and to the same end: the *position* is rounded, not the distance
      // travelled. Rounding the distance would keep whatever offset from the grid the corner had when
      // it was picked up, so two corners that started a unit and a half apart could never be lined up.
      // Ctrl turns it off for fine work, as it does everywhere else.
      const snap = event.ctrlKey ? 1 : 4;

      // Three screen pixels is enough to count as a drag anywhere on this canvas, and at anything
      // above about 1.3x zoom that is less than half a snap. On a connector nobody has touched, the
      // press pins the whole route, so a slip that small would turn an automatic connector into a
      // hand-routed one with no visible change, an undo step that undid nothing, and a line that no
      // longer follows its cards. A connector that is already hand-routed has nothing to lose, so it
      // moves from the first pixel.
      if (!drag.origin.previous.length &&
          Math.hypot(dx, dy) / state.view.zoom < snap / 2) {
        applyCorners(relationship, drag.origin.previous, drag.origin.offset, drag.origin.cross);
        render();
        return;
      }

      const moved = dragCornerTo(drag.origin, dx / state.view.zoom, dy / state.view.zoom, snap);

      // A corner that has not actually got anywhere - the drag is still inside one snap step, the
      // only axis it can travel on has not moved, or the leg has been dragged up against the card
      // it ends on - leaves the connector exactly as the press found it. Writing the baked corners
      // anyway would pin a whole route to the shape it already had, with an undo step that undid
      // nothing.
      if (samePinning(moved, drag.origin.base)) {
        applyCorners(relationship, drag.origin.previous, drag.origin.offset, drag.origin.cross);
      } else {
        applyCorners(relationship, moved, 0, 0);
      }
    }

    render();
    return;
  }

  if (drag.mode === 'route') {
    const relationship = relationshipById(drag.routeId);
    if (!relationship) return;

    // A route the user has already shaped by hand has no automatic shape left for the two offsets
    // to move the middle of, so a drag on it moves the leg it was grabbed by - the same thing a
    // drag on a corner does, grabbed by the leg instead of the corner. Carrying every corner at once
    // would move the shape away from both ends, which stay on their columns, and leave the router to
    // reconnect them with stray legs.
    if (drag.origin.waypoints.length && drag.origin.leg !== null) {
      const snap = event.ctrlKey ? 1 : 4;
      const moved = dragLegTo(drag.origin, dx / state.view.zoom, dy / state.view.zoom, snap);

      if (moved) applyCorners(relationship, moved, 0, 0);
      else applyCorners(relationship, drag.origin.waypoints, drag.origin.offset, drag.origin.cross);

      render();
      return;
    }

    const delta = (drag.routeAxis === 'y' ? dy : dx) / state.view.zoom;
    relationship.routeOffset = drag.origin.offset + delta;

    if (drag.routeCrossAxis) {
      const across = (drag.routeCrossAxis === 'y' ? dy : dx) / state.view.zoom;
      relationship.routeOffsetCross = drag.origin.cross + across;
    }

    render();
    return;
  }

  if (drag.mode === 'row') {
    dragRowTo(event);
    return;
  }

  if (drag.mode === 'draw-arrow') {
    const world = toWorld(event.clientX, event.clientY);
    const vector = constrainVector(
      world.x - drag.startWorld.x, world.y - drag.startWorld.y,
      event.shiftKey, event.ctrlKey ? 1 : 4);

    state.pendingArrow.dx = vector.dx;
    state.pendingArrow.dy = vector.dy;
    render();
    return;
  }

  if (drag.mode === 'arrow-end' || drag.mode === 'arrow-start') {
    const annotation = annotationById(drag.resizeId);
    if (!annotation) return;

    const snap = event.ctrlKey ? 1 : 4;
    const worldDx = Math.round((dx / state.view.zoom) / snap) * snap;
    const worldDy = Math.round((dy / state.view.zoom) / snap) * snap;

    if (drag.mode === 'arrow-end') {
      const vector = constrainVector(
        drag.origin.dx + worldDx, drag.origin.dy + worldDy, event.shiftKey, snap);
      annotation.dx = vector.dx;
      annotation.dy = vector.dy;
    } else {
      // The tail moves and the head stays put, so the vector takes the opposite correction.
      annotation.x = drag.origin.x + worldDx;
      annotation.y = drag.origin.y + worldDy;
      annotation.dx = drag.origin.dx - worldDx;
      annotation.dy = drag.origin.dy - worldDy;
    }

    render();
    return;
  }

  if (drag.mode === 'rotate') {
    const annotation = annotationById(drag.resizeId);
    if (!annotation) return;

    // Whole degrees, 15 degree steps with Shift, and the same Ctrl escape hatch for fine work that
    // a move and a resize have. Snapping the *angle itself* rather than the change, unlike the
    // resize: an angle has a meaningful zero, and "straight" is the value people want to land on.
    const snap = event.ctrlKey ? 0.5 : event.shiftKey ? 15 : 1;

    const turned = angleAt(drag.origin.centre, toWorld(event.clientX, event.clientY));
    const delta = wrapDegrees(turned - drag.origin.pointer);

    annotation.tilt = wrapDegrees(Math.round((drag.origin.tilt + delta) / snap) * snap);

    render();
    return;
  }

  if (drag.mode === 'resize') {
    const annotation = annotationById(drag.resizeId);
    if (!annotation) return;

    // Same snap as a move, and the same Ctrl escape hatch for fine adjustment.
    const snap = event.ctrlKey ? 1 : 8;

    // Both sides move independently. A *new* note is square - see NOTE_DEFAULT_SIZE - but it is
    // not held square, because a note stretched into a banner is a legitimate thing to want.
    //
    // The *change* is snapped rather than the finished size. A note's default side is 140, which
    // is not a multiple of the 8-unit snap, so snapping the total would jump a new note to 144 the
    // moment its grip was touched, and no drag could ever put it back.
    //
    // The travel is turned into the note's own frame first. Width and height are lengths along the
    // note's local axes, which can point anywhere once the note is turned: at a half turn its grip is
    // at the top left of the screen, so raw screen travel added to the width would grow it away from
    // the pointer. Below five degrees the two frames agree to within a snap step.
    const local = toLocal(dx / state.view.zoom, dy / state.view.zoom, drag.origin.tilt);

    const stepX = Math.round(local.x / snap) * snap;
    const stepY = Math.round(local.y / snap) * snap;

    // A text box has no border and no fill, so it can honestly be one line tall. A sticky note
    // cannot: below about 56 units it is a coloured square with nothing legible on it.
    const minHeight = annotationKind(annotation) === 'text' ? 24 : MIN_NOTE_HEIGHT;

    const width = Math.max(MIN_NOTE_WIDTH, drag.origin.width + stepX);
    const height = Math.max(minHeight, drag.origin.height + stepY);

    annotation.width = width;
    annotation.height = height;

    // Then put the note back where it has to be for the far corner to have stayed still. The
    // placed rectangle is axis-aligned and the drawn one is not, so this is the only step that
    // knows about the tilt at all - everything downstream still reads x, y, width and height.
    const centre = translate(drag.origin.anchor, { x: width / 2, y: height / 2 }, drag.origin.tilt);

    annotation.x = centre.x - width / 2;
    annotation.y = centre.y - height / 2;

    render();
    return;
  }

  if (drag.mode === 'move') {
    const worldDx = dx / state.view.zoom;
    const worldDy = dy / state.view.zoom;
    const snap = event.ctrlKey ? 1 : 8;

    for (const entry of drag.origin) {
      const target = entry.kind === 'table' ? tableById(entry.id) : annotationById(entry.id);
      if (!target) continue;
      target.x = Math.round((entry.x + worldDx) / snap) * snap;
      target.y = Math.round((entry.y + worldDy) / snap) * snap;
    }

    render();
  }
}

function onPointerUp(event) {
  if (!drag.mode) return;

  // The release of a pointer that is not the one holding this gesture. Ending the gesture here
  // would null the mode and release the capture for the wrong pointer, and the drag the other one
  // is still making would go on with nothing left to commit it.
  if (!ownsDrag(event)) return;

  const mode = drag.mode;
  drag.mode = null;
  canvas.classList.remove('is-panning');

  if (drag.button === 2) {
    suppressContextMenu = drag.moved;

    const held = pendingMenu;
    pendingMenu = null;
    if (held && !drag.moved) showMenuFor(held);
  }

  try { canvas.releasePointerCapture(event.pointerId); } catch (error) { /* pointer already gone */ }

  if (mode === 'corner') {
    const relationship = relationshipById(drag.routeId);
    drag.routeId = null;

    if (!relationship) return;

    // Shift on a handle without a drag is the short way to release one corner. The gesture is over
    // before the three-pixel threshold, so nothing has been written yet and the commit below is
    // handed the snapped corners directly.
    if (!drag.moved) {
      // Measured against what the connector had before the drag, not against the corners the drag
      // is working within: on an untouched connector those are the whole drawn route, so a bare
      // Shift-click would look like it was dropping every one of them and write an undo entry that put
      // back exactly what was already there.
      const releasable = !!drag.origin.removal;

      if (!event.shiftKey || !releasable) {
        // A Shift click with nothing to release: the gesture the user is making is the ordinary one
        // of adding this connector to a selection or taking it out again, which is what it would
        // have been a few pixels further along the same line.
        //
        // Shift only. Ctrl is the fine-adjustment modifier for this very drag, so a user holding it to
        // move a corner a unit at a time, who happens not to travel three pixels, keeps the connector in
        // the selection.
        if (event.shiftKey) {
          toggleSelection('relationships', relationship.id);
          render();
          onSelectionChange();
        }
        return;
      }

      applyCorners(relationship, drag.origin.removal,
        drag.origin.removal.length ? 0 : drag.origin.offset,
        drag.origin.removal.length ? 0 : drag.origin.cross);
    }

    const after = clonePoints(relationship.waypoints);
    const afterOffset = relationship.routeOffset;
    const afterCross = relationship.routeOffsetCross;

    // Shift held through a drag on a connector that had no hand-placed corners in the first place
    // leaves it exactly as it was - it was already drawing its automatic route. Committing that
    // would put an undo step on the stack that undoes nothing, which is worse than no gesture at
    // all: the next Ctrl+Z appears to do nothing.
    if (samePinning(after, drag.origin.previous) &&
        afterOffset === drag.origin.offset && afterCross === drag.origin.cross) return;

    applyCorners(relationship, drag.origin.previous, drag.origin.offset, drag.origin.cross);
    mutate('move connector corner', () => {
      applyCorners(relationship, after, afterOffset, afterCross);
    });
    render();
    return;
  }

  if (mode === 'route') {
    const relationship = relationshipById(drag.routeId);
    drag.routeId = null;

    if (relationship && drag.moved) {
      const after = relationship.routeOffset;
      const afterCross = relationship.routeOffsetCross;
      const afterPoints = clonePoints(relationship.waypoints);

      // A drag past the three-pixel threshold whose snapped distance is still zero moved nothing, so
      // it commits nothing: no unsaved mark and no undo step that undoes nothing.
      if (after === drag.origin.offset && afterCross === drag.origin.cross &&
          samePinning(afterPoints, drag.origin.waypoints)) return;

      relationship.routeOffset = drag.origin.offset;
      relationship.routeOffsetCross = drag.origin.cross;

      // Left alone on a connector that has none, so an ordinary offset drag does not write an empty
      // list onto a relationship whose routing the gesture never touched.
      const carriesCorners = afterPoints.length || drag.origin.waypoints.length;
      if (carriesCorners) relationship.waypoints = clonePoints(drag.origin.waypoints);

      mutate('move connector', () => {
        relationship.routeOffset = after;
        relationship.routeOffsetCross = afterCross;
        if (carriesCorners) relationship.waypoints = afterPoints;
      });
      render();
    }

    return;
  }

  if (mode === 'row') {
    const table = tableById(drag.rowTableId);
    drag.rowTableId = null;

    if (table && drag.moved) {
      const after = table.columnOrder;
      table.columnOrder = drag.origin.order;
      mutate('move column', () => { table.columnOrder = after; });
      render();
    }

    return;
  }

  if (mode === 'draw-arrow') {
    const pending = state.pendingArrow;
    state.pendingArrow = null;

    // A click without a drag is not an arrow. Committing one would leave a zero-length mark on the
    // canvas that draws nothing and can only be found by marquee.
    //
    // The tool stays armed rather than disarming: the other two draw tools are click-to-place, so
    // a click is the obvious thing to try first. Armed, the banner is still up saying to drag, and
    // Escape still cancels.
    if (!pending || Math.hypot(pending.dx, pending.dy) < 10) {
      render();
      return;
    }

    endDrawMode();

    const arrow = newAnnotation('arrow', { x: pending.x, y: pending.y },
      { dx: pending.dx, dy: pending.dy, ink: pending.ink });

    mutate('draw arrow', () => { state.doc.annotations.push(arrow); });
    selectOnly('annotations', arrow.id);
    render();
    onSelectionChange();
    onAnnotationPlaced(arrow);
    return;
  }

  if (mode === 'arrow-end' || mode === 'arrow-start') {
    const annotation = annotationById(drag.resizeId);
    drag.resizeId = null;

    // Same shape as every other live drag: the new geometry is already applied, so the undo
    // snapshot has to be taken from where the arrow started.
    if (annotation && drag.moved) {
      const after = {
        x: annotation.x, y: annotation.y, dx: annotation.dx, dy: annotation.dy
      };

      Object.assign(annotation, {
        x: drag.origin.x, y: drag.origin.y, dx: drag.origin.dx, dy: drag.origin.dy
      });

      mutate('reshape arrow', () => { Object.assign(annotation, after); });
      render();

      // The arrow panel prints the length, and this drag is what changes it.
      refreshInspectorSoon();
    }

    return;
  }

  if (mode === 'rotate') {
    const annotation = annotationById(drag.resizeId);
    drag.resizeId = null;

    // Committed like every other live drag: the new angle is already applied, so the undo snapshot
    // has to be taken from where the note started. A note that had no angle of its own goes back
    // to having none rather than to the derived one written out as a number - undoing a rotation
    // should leave the file exactly as it was, and an explicit tilt is carried into the draw.io
    // export where a derived slant deliberately is not.
    if (annotation && drag.moved) {
      const after = annotation.tilt;

      if (drag.origin.hadTilt) annotation.tilt = drag.origin.tilt;
      else delete annotation.tilt;

      mutate('rotate note', () => { annotation.tilt = after; });
      render();
      refreshInspectorSoon();
    }

    return;
  }

  if (mode === 'resize') {
    const annotation = annotationById(drag.resizeId);
    drag.resizeId = null;

    // Committed the same way as a move: the live drag already applied the new size, so the
    // undo snapshot has to be taken from the size the note started at. Position as well as size,
    // because holding the far corner still moves a turned note as it grows.
    if (annotation && drag.moved) {
      const after = {
        width: annotation.width, height: annotation.height,
        x: annotation.x, y: annotation.y
      };

      Object.assign(annotation, {
        width: drag.origin.width, height: drag.origin.height,
        x: drag.origin.x, y: drag.origin.y
      });

      mutate('resize note', () => { Object.assign(annotation, after); });

      render();
      refreshInspectorSoon();
    }

    return;
  }

  if (mode === 'marquee') {
    finishMarquee(drag.startScreen, { x: event.clientX, y: event.clientY }, event.shiftKey || event.ctrlKey);
    hideMarquee();
    return;
  }

  if (mode === 'move' && drag.moved) {
    // Commit the drag as one undoable step. The positions were already applied live, so the
    // snapshot has to be taken from where things were before the drag started.
    const after = captureMovablePositions();
    const before = drag.origin;

    for (const entry of before) {
      const target = entry.kind === 'table' ? tableById(entry.id) : annotationById(entry.id);
      if (target) { target.x = entry.x; target.y = entry.y; }
    }

    mutate('move', () => {
      for (const entry of after) {
        const target = entry.kind === 'table' ? tableById(entry.id) : annotationById(entry.id);
        if (target) { target.x = entry.x; target.y = entry.y; }
      }
    });
  }

  if (mode === 'pan') {
    state.doc.view = { zoom: state.view.zoom, panX: state.view.panX, panY: state.view.panY };
  }
}

// -------------------------------------------------------------- marquee ---

function drawMarquee(from, to) {
  const box = canvas.getBoundingClientRect();
  const rect = $('#marquee');

  rect.setAttribute('x', Math.min(from.x, to.x) - box.left);
  rect.setAttribute('y', Math.min(from.y, to.y) - box.top);
  rect.setAttribute('width', Math.abs(to.x - from.x));
  rect.setAttribute('height', Math.abs(to.y - from.y));
  rect.style.display = '';
}

function hideMarquee() {
  $('#marquee').style.display = 'none';
}

function finishMarquee(fromScreen, toScreen, additive) {
  if (!drag.moved) return;

  const a = toWorld(fromScreen.x, fromScreen.y);
  const b = toWorld(toScreen.x, toScreen.y);

  const box = {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y)
  };

  if (!additive) clearSelection();

  for (const table of state.doc.tables) {
    if (rectsIntersect(box, tableRect(table))) state.selection.tables.add(table.id);
  }

  for (const annotation of state.doc.annotations) {
    if (rectsIntersect(box, annotationBounds(annotation))) state.selection.annotations.add(annotation.id);
  }

  render();
  onSelectionChange();
}

// ----------------------------------------------------------------- zoom ---

function onWheel(event) {
  event.preventDefault();

  if (event.shiftKey) {
    state.view.panX -= event.deltaY;
    render();
    return;
  }

  const factor = Math.exp(-event.deltaY * 0.0016);
  zoomAt(event.clientX, event.clientY, state.view.zoom * factor);
}

export function zoomAt(clientX, clientY, targetZoom) {
  const box = canvas.getBoundingClientRect();
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, targetZoom));

  const worldX = (clientX - box.left - state.view.panX) / state.view.zoom;
  const worldY = (clientY - box.top - state.view.panY) / state.view.zoom;

  state.view.zoom = zoom;
  state.view.panX = clientX - box.left - worldX * zoom;
  state.view.panY = clientY - box.top - worldY * zoom;
  state.doc.view = { zoom: state.view.zoom, panX: state.view.panX, panY: state.view.panY };

  render();
  notify('zoom');
}

export function zoomBy(factor) {
  const box = canvas.getBoundingClientRect();
  zoomAt(box.left + box.width / 2, box.top + box.height / 2, state.view.zoom * factor);
}

/**
 * Steps the zoom by whole 5% increments of natural size, snapping to the grid of 5s first so a
 * wheel zoom followed by a button press still lands on a round number.
 */
export function zoomStep(steps) {
  const current = Math.round(state.view.zoom / ZOOM_STEP) * ZOOM_STEP;
  const target = Math.round((current + steps * ZOOM_STEP) / ZOOM_STEP) * ZOOM_STEP;

  const box = canvas.getBoundingClientRect();
  zoomAt(box.left + box.width / 2, box.top + box.height / 2, target);
}

export function resetZoom() {
  zoomTo(1);
}

/** Jumps straight to a zoom level, keeping the centre of the viewport where it is. */
export function zoomTo(zoom) {
  const box = canvas.getBoundingClientRect();
  zoomAt(box.left + box.width / 2, box.top + box.height / 2, zoom);
}

/**
 * Opens the canvas at natural size.
 *
  * 100% is the size the whole drawing is designed at, so a diagram of any size opens readable
  * rather than at whatever percentage would make it fit. The pan puts the top-left of the content
  * just inside the visible area, clear of the command bar and the left panel, and Fit is one click
  * away when it is wanted.
 */
export function resetView() {
  const rects = state.doc.tables.map(tableRect);
  for (const annotation of state.doc.annotations) rects.push(annotationBounds(annotation));

  state.view.zoom = 1;

  if (!rects.length) {
    state.view.panX = 60;
    state.view.panY = 90;
  } else {
    const leftPanel = document.getElementById('left-panel');
    const leftInset = leftPanel && !leftPanel.classList.contains('is-collapsed')
      ? leftPanel.offsetWidth + 28 : 50;

    state.view.panX = leftInset + 40 - Math.min(...rects.map(r => r.x));
    state.view.panY = 110 - Math.min(...rects.map(r => r.y));
  }

  state.doc.view = { zoom: state.view.zoom, panX: state.view.panX, panY: state.view.panY };

  render();
  notify('zoom');
}

/** Fits everything on the canvas, allowing for the floating panels covering the edges. */
export function fitToView(padding) {
  // Keyed on both, not on tables alone: a diagram of sticky notes and arrows with no cards in it
  // is a perfectly ordinary thing to draw, and it has to be fittable too.
  const tables = state.doc.tables;
  const annotations = state.doc.annotations || [];

  if (!tables.length && !annotations.length) {
    state.view.zoom = 1;
    state.view.panX = 60;
    state.view.panY = 90;
    render();
    notify('zoom');
    return;
  }

  // documentBounds rather than a local pass over the card and note rectangles: it measures the
  // connector routes too, so a connector that has been dragged clear of the cards it joins can be
  // brought back into view. Asked for with no padding of its own - the inset below is this
  // function's margin, and adding both would fit the diagram smaller than it needs to be.
  const bounds = documentBounds(0);
  const minX = bounds.x;
  const minY = bounds.y;
  const maxX = bounds.x + bounds.width;
  const maxY = bounds.y + bounds.height;

  const box = canvas.getBoundingClientRect();
  const inset = padding === undefined ? 40 : padding;

  const leftPanel = document.getElementById('left-panel');
  const leftInset = leftPanel && !leftPanel.classList.contains('is-collapsed') ? leftPanel.offsetWidth + 28 : 50;
  const inspector = document.getElementById('inspector');
  const rightInset = inspector && !inspector.hidden ? inspector.offsetWidth + 28 : 50;
  const topInset = 90;
  const bottomInset = 70;

  const available = {
    width: Math.max(120, box.width - leftInset - rightInset - inset * 2),
    height: Math.max(120, box.height - topInset - bottomInset - inset * 2)
  };

  const contentWidth = Math.max(1, maxX - minX);
  const contentHeight = Math.max(1, maxY - minY);

  // Never magnify past natural size: 100% is the reference the zoom readout is built around, and
  // a small diagram blown up to 140% just looks wrong. Rounded down to a whole 5% step so the
  // readout after a fit matches the steps the buttons move in.
  const raw = Math.min(available.width / contentWidth, available.height / contentHeight, 1);
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(raw / ZOOM_STEP) * ZOOM_STEP));

  state.view.zoom = zoom;
  state.view.panX = leftInset + inset + (available.width - contentWidth * zoom) / 2 - minX * zoom;
  state.view.panY = topInset + inset + (available.height - contentHeight * zoom) / 2 - minY * zoom;
  state.doc.view = { zoom: state.view.zoom, panX: state.view.panX, panY: state.view.panY };

  render();
  notify('zoom');
}

/** Centres the viewport on a table without changing zoom. */
export function focusTable(tableId) {
  const table = tableById(tableId);
  if (!table) return;

  const size = measureTable(table);
  const box = canvas.getBoundingClientRect();

  state.view.panX = box.width / 2 - (table.x + size.width / 2) * state.view.zoom;
  state.view.panY = box.height / 2 - (table.y + size.height / 2) * state.view.zoom;

  render();
  notify('focus');
}

// ------------------------------------------------------------- keyboard ---

function onKeyDown(event) {
  if (isTypingTarget(event.target)) return;

  // A dialog is covering the canvas, and every shortcut below acts on that canvas. Opening a
  // dialog focuses nothing, so activeElement stays on the body or on the command-bar button that
  // was clicked - neither is a typing target - and Delete would otherwise remove the selection
  // behind the backdrop with no confirmation. Escape needs no exception: ui.js listens for it on
  // the document, which is ahead of this window listener and stops the event there, so the dialog
  // still closes.
  if (isModalCovering()) return;

  if (event.code === 'Space' && !drag.spaceHeld) {
    drag.spaceHeld = true;
    canvas.classList.add('is-pan-ready');
    event.preventDefault();
    return;
  }

  const ctrl = event.ctrlKey || event.metaKey;

  if (ctrl && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    clearSelection();
    for (const table of state.doc.tables) state.selection.tables.add(table.id);
    render();
    onSelectionChange();
    return;
  }

  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    deleteSelection();
    return;
  }

  if (event.key === 'Escape') {
    // Escape backs out of the most recent thing first: connect mode, then a draw tool, then a drag
    // in flight, then an open note, then a path highlight, then the selection. Clearing them all at
    // once would take away context the user was still using.
    if (state.connect && state.connect.fromTableId) { endConnectMode(); return; }

    // Above the drag below, and deliberately. An arrow being dragged out is both - a draw mode and
    // a drag - and ending the draw mode puts away the armed tool, the banner and the half-drawn arrow
    // painted by renderOverlay in one Escape.
    if (isDrawing() || state.pendingArrow) {
      drag.mode = null;
      endDrawMode();
      render();
      return;
    }

    // Any other drag in flight. Without this the ladder below would run while the button was still
    // held: clearing the selection takes the row grips off a card being reordered, while the card
    // goes on reordering under the pointer and the release still commits it.
    if (drag.mode) {
      abandonDrag();
      render();
      return;
    }

    if (state.openNote) {
      state.openNote = null;
      render();
      return;
    }

    if (state.highlightPath) {
      state.highlightPath = null;
      render();
      return;
    }

    clearSelection();
    render();
    onSelectionChange();
    return;
  }

  if (!ctrl && (event.key === '+' || event.key === '=')) { zoomStep(1); return; }
  if (!ctrl && (event.key === '-' || event.key === '_')) { zoomStep(-1); return; }
  if (!ctrl && event.key === '0') { resetZoom(); return; }
  if (!ctrl && event.key.toLowerCase() === 'f') { fitToView(); return; }
}

function onKeyUp(event) {
  if (event.code === 'Space') {
    drag.spaceHeld = false;
    canvas.classList.remove('is-pan-ready');
  }
}

/** The keyup for a held Space never arrives if the window lost focus first. See initInteractions. */
function onWindowBlur() {
  if (!drag.spaceHeld) return;
  drag.spaceHeld = false;
  canvas.classList.remove('is-pan-ready');
}

/**
 * Whether focus is somewhere a keystroke means text rather than a command.
 *
  * Exported because app.js's Ctrl-shortcuts need the same test, and one copy keeps the two
  * agreeing - including on contenteditable, so Ctrl+Z inside a note does not revert a canvas edit.
 */
export function isTypingTarget(node) {
  if (!node) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
}

/**
 * Whether a dialog is on screen.
 *
 * Read off the DOM rather than by importing ui.js's isModalOpen: ui.js is the layer underneath
 * this one and deliberately knows nothing about the canvas - see the dmd:modal-opened listener in
 * initInteractions - so the dependency runs one way only. #modal-root is emptied and hidden when
 * the last dialog closes, so its first child answers the same question.
 */
function isModalCovering() {
  const root = document.getElementById('modal-root');
  return !!(root && !root.hidden && root.firstChild);
}

/**
 * Removes the selected objects from the diagram. This is a diagram-level delete: nothing is
 * removed from Dataverse, which the confirmation wording makes explicit.
 */
export function deleteSelection() {
  const tableCount = state.selection.tables.size;
  const linkCount = state.selection.relationships.size;
  const noteCount = state.selection.annotations.size;

  if (!tableCount && !linkCount && !noteCount) return;

  mutate('delete', () => {
    for (const id of Array.from(state.selection.tables)) removeTable(id);
    for (const id of Array.from(state.selection.relationships)) removeRelationship(id);
    for (const id of Array.from(state.selection.annotations)) removeAnnotation(id);
  });

  clearSelection();
  render();
  onSelectionChange();
}

// -------------------------------------------------------------- context ---

function onCanvasContextMenu(event) {
  event.preventDefault();

  if (suppressContextMenu) {
    suppressContextMenu = false;
    return;
  }

  if (drag.mode === 'pan' && drag.button === 2) {
    pendingMenu = { target: event.target, clientX: event.clientX, clientY: event.clientY };
    return;
  }

  showMenuFor(event);
}

function showMenuFor(source) {
  // A corner handle names its own connector. The hit test underneath is a proximity search through
  // the document in order, with a threshold in *world* units - so zoomed out, or where two lines
  // cross, it answers with whichever connector is nearest rather than the one the handle belongs
  // to, and the menu would open for a different line.
  const handle = source.target && source.target.closest
    ? source.target.closest('[data-corner]') : null;

  const hit = handle && relationshipById(handle.getAttribute('data-id'))
    ? { kind: 'relationship', id: handle.getAttribute('data-id') }
    : hitTest(source);
  if (hit) {
    const kind = hit.kind === 'table' ? 'tables'
      : hit.kind === 'relationship' ? 'relationships' : 'annotations';

    if (!state.selection[kind].has(hit.id)) {
      selectOnly(kind, hit.id);
      render();
      onSelectionChange();
    }
  }

  onContextMenu(source, hit, toWorld(source.clientX, source.clientY));
}

function onDoubleClick(event) {
  const hit = hitTest(event);
  if (!hit) return;
  event.preventDefault();
  onOpenEditor(hit, toWorld(event.clientX, event.clientY));
}

export function isPanning() { return drag.mode === 'pan'; }

// ------------------------------------------------------- connect mode ----

/**
 * Arms "click the other end". The banner is the whole point: a mode with no visible sign it is on
 * is a trap, and Escape or a click on empty canvas always gets out of it.
 */
export function startConnectMode(fromTableId) {
  endDrawMode();

  state.connect = { fromTableId };
  canvas.classList.add('is-connecting');

  const table = tableById(fromTableId);
  const name = table ? (table.displayName || table.logicalName) : 'this table';

  showBanner('Click the other table to draw a proposed relationship from ' + name +
             '.  Escape to cancel.');
}

export function endConnectMode() {
  state.connect = null;
  if (canvas) canvas.classList.remove('is-connecting');
  hideBanner();
}

export function isConnecting() { return !!(state.connect && state.connect.fromTableId); }

// ---------------------------------------------------------- draw tools ----

/**
 * Arms one of the draw tools.
 *
 * The same shape as connect mode, and for the same reason: the next click on the canvas is about to
 * mean something other than "select this", and a mode with nothing on screen saying it is on is a
 * trap. Escape and a right-click always get out of it, opening any dialog cancels it, and for the
 * note and text tools a left click is what places the thing rather than a way out.
 */
export function startDrawMode(tool, options) {
  endConnectMode();

  state.draw = Object.assign({ tool }, options || {});
  if (canvas) canvas.classList.add('is-drawing');

  showBanner(
    tool === 'arrow'
      ? 'Drag on the canvas to draw an arrow.  Hold Shift to keep it straight, Escape to cancel.'
      : tool === 'text'
        ? 'Click on the canvas to place a text box, then type into the Text box on the right.  Escape to cancel.'
        : 'Click on the canvas to place a sticky note, then type into the Text box on the right.  Escape to cancel.');
}

export function endDrawMode() {
  const wasOn = !!state.draw || !!state.pendingArrow;

  state.draw = null;
  state.pendingArrow = null;
  if (canvas) canvas.classList.remove('is-drawing');

  if (wasOn) hideBanner();
}

export function isDrawing() { return !!(state.draw && state.draw.tool); }

/** Drops a sticky note or a text box at a point on the canvas and hands it to the inspector. */
function placeAnnotation(kind, worldPoint) {
  const seed = newAnnotation(kind, { x: 0, y: 0 });

  // Centred horizontally on the click and hung just below it, so the thing appears where the
  // user pointed rather than with its top-left corner there.
  const annotation = newAnnotation(kind, {
    x: Math.round((worldPoint.x - seed.width / 2) / 8) * 8,
    y: Math.round((worldPoint.y - 12) / 8) * 8
  });

  mutate(kind === 'text' ? 'add text box' : 'add sticky note', () => {
    state.doc.annotations.push(annotation);
  });

  selectOnly('annotations', annotation.id);
  render();
  onSelectionChange();
  onAnnotationPlaced(annotation);
}

/**
 * A drag vector, snapped to the grid and optionally to the nearest 45 degrees.
 *
 * Shift-constraint is what makes a horizontal arrow horizontal. Without it, an arrow drawn beside
 * a row of cards is a degree or two off and reads as a mistake rather than as a pointer.
 */
function constrainVector(dx, dy, constrain, snap) {
  let x = dx;
  let y = dy;

  if (constrain) {
    const length = Math.hypot(x, y);
    const step = Math.PI / 4;
    const angle = Math.round(Math.atan2(y, x) / step) * step;

    x = Math.cos(angle) * length;
    y = Math.sin(angle) * length;
  }

  const grid = snap || 1;
  return { dx: Math.round(x / grid) * grid, dy: Math.round(y / grid) * grid };
}

// ------------------------------------------------------------- banner ----

/** The one banner both connect mode and the draw tools use. They are mutually exclusive. */
function showBanner(text) {
  let banner = document.getElementById('connect-banner');

  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'connect-banner';
    banner.className = 'connect-banner';
    document.body.appendChild(banner);
  }

  banner.textContent = text;
  banner.hidden = false;
}

function hideBanner() {
  const banner = document.getElementById('connect-banner');
  if (banner) banner.hidden = true;
}
