// Light and dark palettes.
//
// The DOM chrome is themed with CSS custom properties in app.css. The canvas cannot be, because
// it is drawn as SVG with presentation attributes so that screen, SVG export and PNG export are
// the same drawing. Every colour the renderer uses therefore comes from here instead of being
// written inline, and this module is the one place a theme is defined for both runtimes.
//
// Export always uses the light palette. A dark PNG dropped into a Word document or a slide deck
// is almost never what someone wants, so buildExportSvg wraps itself in withLightPalette().
//
// state.js is imported for one thing only - the names the user has given their emphasis colours,
// which are a diagram setting. state.js imports nothing from here, so there is no cycle; keep it
// that way.

import { state } from './state.js';

const LIGHT = {
  name: 'light',

  canvas: '#ffffff',
  gridDot: '#c8d2e4',
  gridDotRadius: 1.15,

  connector: '#8ea3c4',
  connectorSelected: '#1f5fe0',
  connectorDim: '#dfe5ef',
  selection: '#1f5fe0',

  rowRule: '#eef1f6',
  rowInk: '#2c3648',
  rowProposedInk: '#a4700f',
  rowDeprecatedInk: '#9b2c22',
  typeInk: '#8a93a5',
  subtitleInk: '#7a869b',
  hintInk: '#8a93a5',

  markerPk: '#a4700f',
  markerFk: '#1f5fe0',
  markerAk: '#7a4fd1',

  proposedRule: '#dda93a',

  labelChip: '#ffffff',
  labelChipOpacity: 0.92,
  labelInk: '#5b6577',
  labelProposedInk: '#a4700f',

  badgeFill: '#ffffff',
  noteTagFill: '#fff8e1',
  noteTagLine: '#d9bf6e',
  noteTagInk: '#8a6a12',

  // Ownership pill. Deliberately neutral: it is a second dimension of information on a card that
  // is already colour-coded by status, so it reads as an annotation rather than competing.
  ownershipLine: '#c3cad6',
  ownershipInk: '#67717f',

  missing: '#c0392f',
  missingFill: '#fdf0ee',

  // The asterisk against a mandatory column. Its own token rather than a reuse of `missing`,
  // because the two say different things on the same card - "Dataverse has not got this any more"
  // against "this column has to be filled in" - and a reader who has learned one red should not
  // have to work out which one they are looking at.
  //
  // Checked against every fill a row can sit on rather than by eye: white, the three non-Existing
  // card fills and the ochre band behind a proposed row. The worst of those is 5.45:1, so it
  // clears WCAG AA for text everywhere it can be drawn.
  requiredMark: '#b3261e',

  annotationFill: '#fff8e1',
  annotationLine: '#e8d9a8',
  annotationInk: '#3d4759',
  annotationHandle: '#c3a95a',

  panelFill: '#ffffff',
  panelLine: '#e4e9f2',
  titleInk: '#101725',

  shadowOpacity: 0.1,

  // What an emphasis colour is mixed towards to make the card header. The body is never
  // tinted - see emphasisHead.
  tintTarget: '#ffffff',
  headTint: 0.86,
  lineTint: 0.55,

  status: {
    Existing: { stroke: '#d5dceb', fill: '#ffffff', head: '#eaf1ff', headLine: '#d3e0f8', mark: '#1f5fe0', dash: null, ink: '#101725' },
    Proposed: { stroke: '#c98a12', fill: '#fffdf7', head: '#fff4dc', headLine: '#f0dfae', mark: '#c98a12', dash: '5 4', ink: '#101725' },
    External: { stroke: '#7a4fd1', fill: '#fdfbff', head: '#f1e9ff', headLine: '#ddd0f5', mark: '#7a4fd1', dash: '5 4', ink: '#101725' },
    Deprecated: { stroke: '#c0392f', fill: '#fffbfa', head: '#fbe6e2', headLine: '#f3cdc7', mark: '#c0392f', dash: '3 4', ink: '#6f4a45' }
  }
};

/**
 * Dark palette, raised in contrast throughout.
 *
 * Grey on dark reads as disabled rather than secondary - and secondary text is most of what a
 * card says, the column names, their types and the schema-name subtitle - so every ink here is
 * lifted towards white and the type and subtitle inks in particular sit well clear of the fill
 * behind them. The card fills are lifted off the canvas as well, so a card is a card before its
 * border is read.
 *
 * Mirrored by the custom properties in app.css. The two are kept in step by hand: the canvas is
 * SVG drawn with presentation attributes so that screen and export are the same drawing, and CSS
 * cannot reach it.
 */
const DARK = {
  name: 'dark',

  canvas: '#141924',
  gridDot: '#3f4a63',
  gridDotRadius: 1.15,

  connector: '#8494b3',
  connectorSelected: '#7ea6ff',
  connectorDim: '#333d52',
  selection: '#7ea6ff',

  rowRule: '#333d51',
  rowInk: '#e4eaf4',
  rowProposedInk: '#f0c165',
  rowDeprecatedInk: '#f2917f',
  typeInk: '#a6b2c6',
  subtitleInk: '#aab5c8',
  hintInk: '#a6b2c6',

  markerPk: '#f0c165',
  markerFk: '#7ea6ff',
  markerAk: '#c4aaf5',

  proposedRule: '#c99a2c',

  labelChip: '#1a2130',
  labelChipOpacity: 0.94,
  labelInk: '#b3becf',
  labelProposedInk: '#f0c165',

  badgeFill: '#232b3c',
  noteTagFill: '#40331a',
  noteTagLine: '#8d7429',
  noteTagInk: '#f0d488',

  ownershipLine: '#5e6a80',
  ownershipInk: '#b3becf',

  missing: '#f2917f',
  missingFill: '#3a2320',

  // Lifted well off the dark card fills for the same reason every other ink here is - a dark red
  // on a dark ground reads as disabled rather than as a warning. Worst case against the fills a
  // row can sit on is 5.19:1. Red on dark inevitably lands in the same family as the other reds
  // in this palette; the asterisk is told apart by where it is, not by its hue.
  requiredMark: '#ff8f7a',

  annotationFill: '#372d1b',
  annotationLine: '#6d5a2b',
  annotationInk: '#f0e9d8',
  annotationHandle: '#a08a45',

  panelFill: '#1e2534',
  panelLine: '#3a4559',
  titleInk: '#f0f3f9',

  shadowOpacity: 0.5,

  tintTarget: '#1e2534',
  headTint: 0.7,
  lineTint: 0.42,

  status: {
    Existing: { stroke: '#44557a', fill: '#212a3b', head: '#28395a', headLine: '#41598a', mark: '#7ea6ff', dash: null, ink: '#f0f3f9' },
    Proposed: { stroke: '#d9a334', fill: '#2b2418', head: '#443619', headLine: '#7a6524', mark: '#edb54a', dash: '5 4', ink: '#f8f0df' },
    External: { stroke: '#ab8bea', fill: '#282136', head: '#372c4e', headLine: '#5c4c80', mark: '#b99bf2', dash: '5 4', ink: '#f2ecfd' },
    Deprecated: { stroke: '#dd6a5c', fill: '#2f211f', head: '#452925', headLine: '#7a4740', mark: '#ef7a6b', dash: '3 4', ink: '#f8e3df' }
  }
};

const PALETTES = { light: LIGHT, dark: DARK };

let active = 'light';
let forced = null;

/** The palette the renderer should draw with right now. */
export function palette() {
  return PALETTES[forced || active] || LIGHT;
}

export function currentTheme() {
  return active;
}

/**
 * Switches the theme. The DOM side is a class on <body> that app.css keys its custom
 * properties off; the canvas side is the palette above.
 */
export function setTheme(name) {
  active = name === 'dark' ? 'dark' : 'light';

  const body = typeof document !== 'undefined' ? document.body : null;
  if (body && body.classList) {
    body.classList.toggle('theme-dark', active === 'dark');
    body.classList.toggle('theme-light', active !== 'dark');
  }

  return active;
}

/** Runs a function with the light palette forced, whatever the user's theme is. */
export function withLightPalette(fn) {
  const previous = forced;
  forced = 'light';
  try {
    return fn();
  } finally {
    forced = previous;
  }
}

/**
 * Mixes two hex colours. Used to turn a saturated emphasis colour into a card fill: the swatch
 * itself is far too heavy behind text, and the inspector swatches use the same maths so what is
 * on the button is what lands on the card.
 */
export function mix(hex, target, amount) {
  const a = parse(hex);
  const b = parse(target);
  if (!a || !b) return hex;

  const t = Math.max(0, Math.min(1, amount));
  const channel = index => Math.round(a[index] + (b[index] - a[index]) * t);

  return '#' + [channel(0), channel(1), channel(2)].map(toHex).join('');
}

/**
 * Card header fill for an emphasis colour, in the current theme.
 *
 * Emphasis colours the header band and the border only. The card body stays the fill its status
 * gives it, so a colour-coded diagram still reads status at a glance and the column text keeps
 * its contrast whatever hue is chosen.
 */
export function emphasisHead(hex) {
  const theme = palette();
  return mix(hex, theme.tintTarget, theme.headTint);
}

/** Header rule for an emphasis colour, in the current theme. */
export function emphasisLine(hex) {
  const theme = palette();
  return mix(hex, theme.tintTarget, theme.lineTint);
}

function parse(hex) {
  const value = String(hex || '').replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  return [0, 2, 4].map(index => parseInt(value.slice(index, index + 2), 16));
}

function toHex(value) {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0');
}

/**
 * Emphasis colours offered in the inspector. These are the hues the canvas draws with, so a
 * swatch shows the card colour it produces rather than an unrelated dot.
 */
export const EMPHASIS_COLOURS = [

  { value: '#1f5fe0', label: 'Blue' },
  { value: '#0f7b8a', label: 'Teal' },
  { value: '#16a34a', label: 'Green' },
  { value: '#6f8f1c', label: 'Olive' },
  { value: '#c98a12', label: 'Amber' },
  { value: '#d9722f', label: 'Orange' },
  { value: '#c0392f', label: 'Red' },
  { value: '#c0468a', label: 'Magenta' },
  { value: '#7a4fd1', label: 'Violet' },
  { value: '#3f6ea8', label: 'Steel' },
  { value: '#8a6236', label: 'Brown' },
  { value: '#546074', label: 'Slate' }
];

/**
 * What an emphasis colour is called.
 *
 * The user's own name for it if they have given it one, otherwise the hue name the swatch picker
 * uses. "Teal" says nothing about a design, but it is at least the same word in the picker, the
 * legend and the export, which is the minimum a legend has to manage.
 *
 * The names live in the diagram settings, so they travel with the .dvmd file rather than being a
 * per-machine preference: a colour scheme that means something is part of the design.
 */
export function emphasisName(colour) {
  if (!colour) return '';

  const key = String(colour).toLowerCase();
  const names = (state.doc && state.doc.settings && state.doc.settings.emphasisNames) || {};
  if (names[key]) return names[key];

  const known = EMPHASIS_COLOURS.find(entry => entry.value.toLowerCase() === key);
  return known ? known.label : colour;
}
