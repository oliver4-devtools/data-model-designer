// Export: format choice, honest fidelity warnings, and rasterisation for PNG.

import { el, clear } from './util.js';
import { host } from './bridge.js';
import { state, annotationKind } from './state.js';
import { buildExportSvg } from './render.js';
import {
  openModal, modalFooter, toast, withProgress, checkbox, furniturePosition
} from './ui.js';

const FORMATS = [
  {
    key: 'Png',
    title: 'PNG image',
    sub: 'For documents, slides and quick sharing',
    detail: 'A flat picture of the canvas at its current detail level. Not editable, and carries no metadata.'
  },
  {
    key: 'Svg',
    title: 'SVG image',
    sub: 'Scalable output for documentation',
    detail: 'Keeps text as text and scales cleanly. Visual only - it is not a data model another tool can read back.'
  },
  {
    key: 'DrawIo',
    title: 'draw.io / diagrams.net',
    sub: 'For further editing elsewhere',
    detail: 'Tables become list shapes with one row per column, relationships become entity-relation edges, and manual layout is preserved. Cascade detail and per-table detail overrides are not carried over.'
  },
  {
    key: 'Visio',
    title: 'Visio (experimental)',
    sub: 'Visio 2003 XML drawing (.vdx)',
    detail: 'Each table is one shape with its columns as text; relationships become connectors. Written as .vdx because a hand-built .vsdx that Visio refuses to open would be worse than none. Check the file opens as you expect before relying on it.'
  },
  {
    key: 'Mermaid',
    title: 'Mermaid',
    sub: 'For wikis and markdown',
    detail: 'An erDiagram block. Structure only: layout, highlights and notes are lost.'
  },
  {
    key: 'DocumentationMarkdown',
    title: 'Documentation (Markdown)',
    sub: 'For an Azure DevOps wiki',
    detail: 'The data-model section of a design document: table catalogue with ownership and columns, relationship list with cascade behaviour, alternate keys, and a register of everything this diagram proposes with the note explaining why. Includes a generated Mermaid diagram. Describes the model, not the picture.'
  },
  {
    key: 'DocumentationHtml',
    title: 'Documentation (HTML)',
    sub: 'Self-contained page that prints',
    detail: 'The same document as a single HTML file with its styling inlined - nothing is fetched when it opens. Prints to PDF from a browser, and Word opens it if you need it in a design document.'
  }
];

const DOCUMENT_FORMATS = new Set(['DocumentationMarkdown', 'DocumentationHtml']);

export function openExportDialog() {
  // Annotations count: a canvas of text boxes and arrows with no tables yet is still a diagram,
  // as it is for Save, so only a canvas with neither is refused.
  if (!state.doc.tables.length && !state.doc.annotations.length) {
    toast('There is nothing on the canvas to export yet.', 'warning');
    return;
  }

  const model = { format: 'Png', scale: 2, transparent: false };

  openModal({
    title: 'Export diagram',
    subtitle: state.doc.title,
    width: 720,
    body: dialog => build(dialog, model),
    footer: dialog => modalFooter(dialog, {
      primaryLabel: 'Export...',
      onPrimary: () => run(model, dialog)
    })
  });
}

function build(dialog, model) {
  const container = el('div', { style: { display: 'grid', gridTemplateColumns: '250px 1fr', minHeight: '340px' } });

  const list = el('div', { style: { borderRight: '1px solid var(--line)', overflow: 'auto' } });
  const detail = el('div', { style: { padding: '16px', overflow: 'auto' } });

  container.append(list, detail);

  function paintList() {
    clear(list);
    for (const format of FORMATS) {
      list.appendChild(el('button', {
        class: 'start-option',
        style: {
          padding: '11px 14px',
          background: model.format === format.key ? 'var(--surface-2)' : 'transparent',
          borderLeft: model.format === format.key ? '3px solid var(--accent)' : '3px solid transparent'
        },
        onClick: () => { model.format = format.key; paintList(); paintDetail(); }
      }, [
        el('div', {}, [
          el('div', { class: 'so-title', text: format.title }),
          el('div', { class: 'so-sub', text: format.sub })
        ])
      ]));
    }
  }

  function paintDetail() {
    clear(detail);
    const format = FORMATS.find(f => f.key === model.format);

    detail.appendChild(el('div', { style: { fontSize: '14px', fontWeight: 600 }, text: format.title }));
    detail.appendChild(el('div', {
      class: 'small', style: { marginTop: '8px', lineHeight: '1.6', color: 'var(--ink-3)' },
      text: format.detail
    }));

    if (model.format === 'Png') {
      detail.appendChild(el('div', { style: { marginTop: '16px' } }, [
        el('div', { class: 'insp-heading', text: 'Resolution' }),
        el('div', { class: 'segmented' }, [1, 2, 3].map(scale => el('button', {
          class: 'seg' + (model.scale === scale ? ' is-active' : ''),
          text: scale + '×',
          onClick: () => { model.scale = scale; paintDetail(); }
        }))),
        el('div', { class: 'small muted', style: { marginTop: '6px' },
          text: '2× is a good default for documents and slides.' })
      ]));
    }

    const warnings = collectWarnings(model.format);
    if (warnings.length) {
      detail.appendChild(el('div', { style: { marginTop: '16px' } }, [
        el('div', { class: 'insp-heading', text: 'What this format cannot carry' }),
        el('ul', { class: 'warn-list' }, warnings.map(warning => el('li', { text: warning })))
      ]));
    }
  }

  paintList();
  paintDetail();

  return container;
}

/**
 * Says what will be lost, based on what is actually on this diagram rather than a generic list.
 * Shown in the dialog before the export runs.
 */
export function collectWarnings(format) {
  const warnings = [];
  const doc = state.doc;

  const hasStatus = doc.tables.some(t => t.status !== 'Existing') ||
                    doc.relationships.some(r => r.status !== 'Existing');
  const hasHighlights = doc.tables.some(t => t.highlight) || doc.relationships.some(r => r.highlight);
  const arrows = doc.annotations.filter(a => annotationKind(a) === 'arrow').length;

  // Notes and text boxes only, not arrows: a canvas whose annotations are all arrows has no
  // notes to mention in the Visio leader-line warning.
  const hasNotes = doc.annotations.length > arrows;

  // Notes the user has turned by hand, which is what `tilt` on an annotation means - see
  // stickyTilt in geometry.js, where an absent one is derived from the note's own id instead.
  const turnedNotes = doc.annotations.filter(a =>
    annotationKind(a) === 'note' && typeof a.tilt === 'number' && isFinite(a.tilt) &&
    Math.abs(a.tilt) > 0.01).length;

  // detailOverride and collapsed are counted apart: ExportRowBuilder.SelectedColumns honours a
  // detail override rather than flattening it, and forces TablesOnly for a collapsed card rather
  // than expanding it, so the two cases need different warnings.
  const collapsedCount = doc.tables.filter(t => t.collapsed).length;
  const hasDetailOverrides = doc.tables.some(t => t.detailOverride && !t.collapsed);

  // Notes typed against a table or a column, which is not the same thing as a sticky note drawn
  // on the canvas - the canvas ones are annotations and are counted above.
  const objectNotes = doc.tables.reduce(
    (total, table) =>
      total + (table.notes ? 1 : 0) +
      (table.columns || []).filter(c => c.notes).length,
    0);
  const hasManyToMany = doc.relationships.some(r => r.included !== false && !r.hidden && r.kind === 'ManyToMany');

  // Connectors the user has routed by hand - corners placed one at a time, or the line dragged
  // clear of another. Given a warning of its own because the three formats that route their own
  // lines discard all of it.
  const routed = doc.relationships.filter(r =>
    r.included !== false && !r.hidden &&
    ((Array.isArray(r.waypoints) && r.waypoints.length) || r.routeOffset || r.routeOffsetCross)).length;

  const routedText = target => routed + ' hand-routed ' + (routed === 1 ? 'connector' : 'connectors') +
    '. ' + target;
  const hasCascade = doc.relationships.some(r => r.cascade);

  if (format === 'Mermaid') {
    warnings.push('Manual layout - the target tool will lay the diagram out itself.');
    if (routed) warnings.push(routedText('Mermaid draws its own lines.'));
    if (hasHighlights) warnings.push('Highlight colours on ' + countHighlights() + ' objects.');
    if (doc.annotations.length) {
      warnings.push(doc.annotations.length + ' ' +
        (doc.annotations.length === 1
          ? 'sticky note, text box or arrow'
          : 'sticky notes, text boxes and arrows') + ' drawn on the canvas.');
    }
    if (hasStatus) warnings.push('Proposed, external and deprecated styling (status is written as a comment instead).');
    if (hasCascade) warnings.push('Cascade configuration.');
  }

  if (format === 'DrawIo') {
    if (hasCascade) warnings.push('Cascade configuration - it is not part of the draw.io model.');

    if (collapsedCount) {
      warnings.push(collapsedCount + ' collapsed ' + (collapsedCount === 1 ? 'card exports' : 'cards export') +
        ' as a header with no columns at all, exactly as the canvas draws ' +
        (collapsedCount === 1 ? 'it' : 'them') + '. Expand ' +
        (collapsedCount === 1 ? 'it' : 'them') + ' first to carry the columns over.');
    }

    if (hasDetailOverrides) {
      warnings.push('Per-table detail overrides are honoured, so a table set to fewer columns than ' +
        'the diagram setting exports with fewer columns.');
    }

    if (objectNotes) {
      warnings.push(objectNotes + ' ' + (objectNotes === 1 ? 'note' : 'notes') +
        ' typed against a table or column. draw.io shapes carry no note field, so these are ' +
        'dropped - sticky notes drawn on the canvas are exported.');
    }

    // The exporter writes every emphasis colour in use into the legend, which is the only thing
    // that says what a coloured border means. With the legend switched off the colours still
    // export and arrive unexplained.
    if (hasHighlights && !doc.settings.showLegend) {
      warnings.push('The meaning of the emphasis colours on ' + countHighlights() + ' objects. ' +
        'They are exported as card and edge strokes, but the legend that names them is switched ' +
        'off for this diagram - turn it on to carry the key across.');
    }

    if (hasManyToMany) warnings.push('N:N intersect tables are named in the edge label only.');

    if (routed) {
      warnings.push(routedText('draw.io routes its own edges, so the corners you placed and the ' +
        'lines you dragged clear are redrawn. Card positions are kept.'));
    }
  }

  if (format === 'Visio') {
    warnings.push('Columns become text inside one shape rather than separately selectable rows.');
    if (routed) warnings.push(routedText('Visio draws its own connectors. Card positions are kept.'));
    if (hasHighlights) warnings.push('Highlight colours.');
    if (doc.settings.showLegend) warnings.push('The legend panel.');
    if (hasNotes) warnings.push('Note leader lines. Sticky notes and text boxes themselves are exported.');

    // Only a hand-set angle is warned about. The slight slant an untouched note is drawn with is
    // derived from its id and is not carried into any file export, so there is nothing to lose.
    if (turnedNotes) {
      warnings.push('The angle of ' + turnedNotes + ' turned sticky ' +
        (turnedNotes === 1 ? 'note' : 'notes') +
        '. Visio 2003 XML shapes are written square to the page here. draw.io keeps the angle.');
    }
    if (arrows) {
      warnings.push(arrows + ' drawn ' + (arrows === 1 ? 'arrow' : 'arrows') +
        '. Visio 2003 XML has no good way to carry a connector with nothing at either end, ' +
        'so they are left out. draw.io keeps them.');
    }
  }

  if (DOCUMENT_FORMATS.has(format)) {
    // A document loses the opposite half of the diagram from every other format here: it keeps
    // the substance and drops the picture, so the warning says the arranged diagram is not in it.
    warnings.push('The arranged picture. The document describes the model in prose and tables; ' +
      'export PNG or SVG alongside it for the layout you have set up.');

    if (hasHighlights) warnings.push('Emphasis colours on ' + countHighlights() + ' objects.');

    const hidden = doc.tables.reduce(
      (total, table) => total + (table.columns || []).filter(c => c.selected === false).length, 0);

    if (hidden) {
      warnings.push(hidden + ' unticked ' + (hidden === 1 ? 'column is' : 'columns are') +
        ' left out, the same as on the canvas.');
    }

    if (doc.tables.some(t => t.status === 'Existing' && !t.ownershipType)) {
      warnings.push('Ownership is missing for some tables - refresh the diagram to record it.');
    }
  }

  if (format === 'Png') warnings.push('Everything is flattened; the file cannot be edited or read back.');
  if (format === 'Svg') warnings.push('The file is a picture, not a model - it cannot be reopened as a diagram.');

  // Where the legend has been dragged to is a screen position: it is held in window pixels and it
  // neither pans nor zooms with the drawing, so there is nothing to map onto a page. Every format
  // that draws a legend draws it in a corner of its own, where it may sit over cards the moved
  // legend had been cleared from.
  if (doc.settings.showLegend && ['Png', 'Svg', 'DrawIo'].includes(format) &&
      furniturePosition(doc.settings.legendX, doc.settings.legendY)) {
    warnings.push('Where you dragged the legend to - the exported legend is drawn in the corner ' +
      'of the picture.');
  }

  return warnings;

  function countHighlights() {
    return doc.tables.filter(t => t.highlight).length + doc.relationships.filter(r => r.highlight).length;
  }
}

// ------------------------------------------------------------------- run --

async function run(model, dialog) {
  const request = { format: model.format, document: state.doc };

  try {
    if (model.format === 'Svg') {
      request.svg = buildExportSvg();
    } else if (model.format === 'Png') {
      request.pngDataUrl = await withProgress('Rendering image...', () => rasterise(model.scale));
    }

    const result = await withProgress('Writing file...', () => host.exportRun(request));

    if (result && result.cancelled) return;

    dialog.close(null);

    toast('Exported to ' + shortenPath(result.path), 'success', {
      list: result.warnings && result.warnings.length ? result.warnings : null,
      timeout: result.warnings && result.warnings.length ? 12000 : 5000
    });
  } catch (error) {
    // withProgress already surfaced the message; nothing further to do.
  }
}

/**
 * Rasterises the exported SVG through an offscreen canvas. The SVG is fully self-contained
 * (no external images or fonts), so the canvas stays origin-clean and toDataURL works.
 */
function rasterise(scale) {
  return new Promise((resolve, reject) => {
    const source = buildExportSvg();
    const parsed = /width="(\d+)"[\s\S]*?height="(\d+)"/.exec(source);
    const width = parsed ? Number(parsed[1]) : 1600;
    const height = parsed ? Number(parsed[2]) : 1000;

    const factor = Math.max(1, Math.min(4, scale || 2));
    const maxDimension = 12000;
    const safeFactor = Math.min(factor, maxDimension / Math.max(width, height));

    const image = new Image();
    const encoded = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(source);

    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * safeFactor);
        canvas.height = Math.round(height * safeFactor);

        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);

        resolve(canvas.toDataURL('image/png'));
      } catch (error) {
        reject(new Error('The image could not be rendered: ' + error.message));
      }
    };

    image.onerror = () => reject(new Error('The canvas could not be converted to an image.'));
    image.src = encoded;
  });
}

function shortenPath(path) {
  if (!path) return '';
  const parts = String(path).split(/[\\/]/);
  return parts.length <= 2 ? path : '...\\' + parts.slice(-2).join('\\');
}
