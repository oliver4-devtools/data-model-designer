// Headless smoke test of the canvas logic: build a document, lay it out, render it,
// and serialise it to SVG. Verification only - never shipped.

import { installDom } from './dom-shim.mjs';
installDom();

const js = '../../src/Oliver4.DataModelDesigner/Web/js/';

const state = await import(js + 'state.js');
const geometry = await import(js + 'geometry.js');
const layout = await import(js + 'layout.js');
const render = await import(js + 'render.js');
const theme = await import(js + 'theme.js');

/** Serialises one on-screen layer, for checks about things exports deliberately leave out. */
function serialiseLayer(id) {
  return new XMLSerializer().serializeToString(document.getElementById(id));
}

/**
 * Both annotation layers at once.
 *
 * An annotation is drawn either behind the tables or in front of them, in two separate groups
 * either side of the table layer, so a check about "what the annotation layer contains" has to
 * look in both - otherwise it silently becomes a check about which layer the fixture happened to
 * land in.
 */
function annotationMarkup() {
  return serialiseLayer('layer-annotations') + serialiseLayer('layer-annotations-front');
}

let failures = 0;
function check(label, condition, detail) {
  if (condition) { console.log('  ok   ' + label); return; }
  console.log('  FAIL ' + label + (detail ? ' - ' + detail : ''));
  failures++;
}

// --------------------------------------------------------------- fixture --

function tableDto(logicalName, displayName, columns) {
  return {
    logicalName, schemaName: displayName.replace(/\s/g, ''), displayName,
    metadataId: logicalName + '-id', objectTypeCode: 1,
    isCustom: logicalName.startsWith('cs_'), isManaged: false, isActivity: false, isIntersect: false,
    primaryIdAttribute: logicalName + 'id', primaryNameAttribute: 'name',
    alternateKeys: [],
    columns: [
      { id: logicalName + 'pk', logicalName: logicalName + 'id', schemaName: logicalName + 'Id',
        displayName: 'Identifier', typeName: 'Unique identifier', attributeType: 'Uniqueidentifier',
        isPrimaryId: true, isPrimaryName: false, isLookup: false, targets: [], selected: true, status: 'Existing' },
      { id: logicalName + 'name', logicalName: 'name', schemaName: 'Name', displayName: 'Name',
        typeName: 'Text (100)', attributeType: 'String',
        isPrimaryId: false, isPrimaryName: true, isLookup: false, targets: [], selected: true, status: 'Existing' },
      ...(columns || [])
    ],
    relationships: []
  };
}

function lookup(name, target) {
  return {
    id: name, logicalName: name, schemaName: name, displayName: name,
    typeName: 'Lookup -> ' + target, attributeType: 'Lookup',
    isPrimaryId: false, isPrimaryName: false, isLookup: true, targets: [target],
    selected: true, status: 'Existing'
  };
}

function relationshipDto(schemaName, referenced, referencing, attribute, kind) {
  return {
    schemaName, displayName: schemaName, metadataId: schemaName,
    kind: kind || 'OneToMany',
    referencedEntity: referenced, referencingEntity: referencing,
    referencedAttribute: referenced + 'id', referencingAttribute: attribute,
    isCustom: false, isManaged: true, isHierarchical: false, isPolymorphic: false,
    lookupTargets: [],
    cascade: { assign: 'Cascade', delete: 'RemoveLink', merge: 'Cascade', reparent: 'Cascade', share: 'Cascade', unshare: 'Cascade' }
  };
}

render.initRenderer();

state.setDocument(state.newDocument('Verification model'), null);

const tables = [
  tableDto('account', 'Account', [lookup('primarycontactid', 'contact'), lookup('parentaccountid', 'account')]),
  tableDto('contact', 'Contact', [lookup('parentcustomerid', 'account')]),
  tableDto('opportunity', 'Opportunity', [lookup('customerid', 'account')]),
  tableDto('quote', 'Quote', [lookup('opportunityid', 'opportunity')]),
  tableDto('cs_territory', 'Territory', [])
];

const relationships = [
  relationshipDto('contact_customer_accounts', 'account', 'contact', 'parentcustomerid'),
  relationshipDto('account_primary_contact', 'contact', 'account', 'primarycontactid'),
  relationshipDto('opportunity_customer_accounts', 'account', 'opportunity', 'customerid'),
  relationshipDto('opportunity_quotes', 'opportunity', 'quote', 'opportunityid'),
  relationshipDto('account_master_account', 'account', 'account', 'parentaccountid'),
  relationshipDto('cs_account_territory', 'account', 'cs_territory', null, 'ManyToMany')
];

console.log('\nDocument construction');
state.mutate('seed', () => {
  state.addTablesFromMetadata(tables);
  state.addRelationshipsFromMetadata(relationships);
});

check('all tables added', state.state.doc.tables.length === 5, state.state.doc.tables.length + ' tables');
check('all relationships added', state.state.doc.relationships.length === 6, state.state.doc.relationships.length + ' relationships');
check('self-referencing relationship kept',
  state.state.doc.relationships.some(r => r.fromTableId === r.toTableId));
check('two distinct relationships between Account and Contact',
  state.state.doc.relationships.filter(r => {
    const a = state.tableById(r.fromTableId), b = state.tableById(r.toTableId);
    if (!a || !b) return false;
    const pair = [a.logicalName, b.logicalName].sort().join('|');
    return pair === 'account|contact';
  }).length === 2);
check('N:N kind preserved', state.state.doc.relationships.some(r => r.kind === 'ManyToMany'));
check('N:1 normalised to 1:N with direction intact', (() => {
  const r = state.state.doc.relationships.find(x => x.schemaName === 'account_primary_contact');
  const from = state.tableById(r.fromTableId), to = state.tableById(r.toTableId);
  return r.kind === 'OneToMany' && from.logicalName === 'contact' && to.logicalName === 'account';
})());

console.log('\nRe-adding is idempotent');
state.mutate('reseed', () => {
  state.addTablesFromMetadata(tables);
  state.addRelationshipsFromMetadata(relationships);
});
check('no duplicate tables', state.state.doc.tables.length === 5, state.state.doc.tables.length + '');
check('no duplicate relationships', state.state.doc.relationships.length === 6, state.state.doc.relationships.length + '');

console.log('\nColumn visibility rules');
state.state.doc.settings.fieldDetail = 'RelationshipFields';
geometry.invalidateSizes();
const account = state.state.doc.tables.find(t => t.logicalName === 'account');
const relColumns = geometry.visibleColumns(account).map(c => c.logicalName);
check('relationship-fields mode includes the primary key', relColumns.includes('accountid'), relColumns.join(','));
check('relationship-fields mode includes lookups behind visible relationships',
  relColumns.includes('parentaccountid'), relColumns.join(','));
check('relationship-fields mode excludes plain columns', !relColumns.includes('name'), relColumns.join(','));

state.state.doc.settings.fieldDetail = 'TablesOnly';
geometry.invalidateSizes();
check('tables-only mode shows no columns', geometry.visibleColumns(account).length === 0);

state.state.doc.settings.fieldDetail = 'AllFields';
geometry.invalidateSizes();
check('all-fields mode shows every selected column', geometry.visibleColumns(account).length === 4);

state.state.doc.settings.fieldDetail = 'RelationshipFields';
geometry.invalidateSizes();

console.log('\nMeasurement and layout');
const size = geometry.measureTable(account);
check('card has a sensible width', size.width >= 172 && size.width <= 340, String(size.width));
check('card height covers its rows', size.height > geometry.METRICS.headerHeight, String(size.height));

layout.applyLayout('Auto');
const positions = state.state.doc.tables.map(t => t.x + ',' + t.y);
check('layout gave every table a position', positions.every(p => /^-?\d/.test(p)));
check('layout did not stack every table on one spot', new Set(positions).size === 5, positions.join(' '));

const overlapping = [];
for (let i = 0; i < state.state.doc.tables.length; i++) {
  for (let j = i + 1; j < state.state.doc.tables.length; j++) {
    const a = geometry.tableRect(state.state.doc.tables[i]);
    const b = geometry.tableRect(state.state.doc.tables[j]);
    if (geometry.rectsIntersect(a, b)) overlapping.push(i + '/' + j);
  }
}
check('layout produced no overlapping cards', overlapping.length === 0, overlapping.join(' '));

for (const mode of ['Grid', 'Horizontal', 'Vertical', 'Hierarchical']) {
  layout.applyLayout(mode);
  check(mode + ' layout runs and positions every table',
    state.state.doc.tables.every(t => Number.isFinite(t.x) && Number.isFinite(t.y)));
}
layout.applyLayout('Auto');

console.log('\nRouting');
let routed = 0;
const groups = geometry.groupRelationships(state.visibleRelationships());
for (const group of groups.values()) {
  group.forEach((relationship, index) => {
    const route = geometry.routeRelationship(relationship, index, group.length);
    if (route && route.points.length >= 2 && route.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) routed++;
  });
}
check('every visible relationship routed', routed === state.visibleRelationships().length,
  routed + ' of ' + state.visibleRelationships().length);

console.log('\nRendering');
render.render();
check('renderer produced table nodes', document.getElementById('layer-tables').children.length === 5);
check('renderer produced link nodes', document.getElementById('layer-links').children.length === 6);

console.log('\nSVG export');
state.state.doc.annotations.push({
  id: 'n1', text: 'Cascade delete is deliberately Remove Link.',
  x: 0, y: -160, width: 260, height: 90, fontSize: 12, bold: false,
  colour: '#3d4759', background: '#fff8e1', border: '#e8d9a8', attachedToId: account.id
});

const svg = render.buildExportSvg();
check('export produced markup', typeof svg === 'string' && svg.length > 1000, String(svg && svg.length));
check('export is a single svg root', svg.startsWith('<svg') && svg.trimEnd().endsWith('</svg>'));
check('export declares the SVG namespace', svg.includes('http://www.w3.org/2000/svg'));
check('export has a viewBox', /viewBox="[-\d. ]+"/.test(svg));
check('export contains table names', svg.includes('Account') && svg.includes('Opportunity'));
check('export contains the note text', svg.includes('Remove Link'));
check('export contains a legend', svg.includes('LEGEND'));
check('export dropped interaction attributes', !svg.includes('data-kind') && !svg.includes('data-hit'));
check('export contains no transparent hit paths', !svg.includes('stroke="transparent"'));
check('export balances its tags', balanced(svg));

console.log('\nProposed and deprecated objects');
state.mutate('propose', () => {
  state.state.doc.tables.push({
    id: 'proposed1', logicalName: null, schemaName: 'cs_customersegment',
    displayName: 'Customer Segment', status: 'Proposed', x: 900, y: 0,
    columns: [{ id: 'p1', logicalName: 'cs_segmentid', displayName: 'Segment',
      typeName: 'Unique identifier', isPrimaryId: true, selected: true, status: 'Proposed', targets: [] }],
    alternateKeys: []
  });
  state.state.doc.relationships.push({
    id: 'proposedrel', schemaName: 'cs_account_segment', kind: 'OneToMany', status: 'Proposed',
    fromTableId: account.id, toTableId: 'proposed1', referencingAttribute: 'cs_accountid',
    included: true, hidden: false, waypoints: [], lookupTargets: []
  });
});

render.render();
const proposedSvg = render.buildExportSvg();
check('proposed table is drawn', proposedSvg.includes('Customer Segment'));
check('proposed status is marked with more than colour', proposedSvg.includes('PROPOSED'));
check('proposed connector is dashed', /stroke-dasharray="5 4"/.test(proposedSvg));

console.log('\nUndo and redo');
const before = state.state.doc.tables.length;
state.mutate('remove', () => state.removeTable('proposed1'));
check('table removed', state.state.doc.tables.length === before - 1);
check('removing a table removed its relationships',
  !state.state.doc.relationships.some(r => r.toTableId === 'proposed1'));
state.undo();
check('undo restored the table', state.state.doc.tables.length === before);
check('undo restored the relationship',
  state.state.doc.relationships.some(r => r.id === 'proposedrel'));
state.redo();
check('redo removed it again', state.state.doc.tables.length === before - 1);

console.log('\nRelationship inclusion');
const excluded = state.state.doc.relationships[0];
state.mutate('exclude', () => { excluded.included = false; });
check('excluding a relationship hides the connector',
  !state.visibleRelationships().some(r => r.id === excluded.id));
check('excluding a relationship keeps both tables',
  state.tableById(excluded.fromTableId) && state.tableById(excluded.toTableId));
check('excluded relationship is still in the document',
  state.state.doc.relationships.some(r => r.id === excluded.id));

console.log('\nSerialisation round trip');
const json = JSON.stringify(state.state.doc);
const reloaded = JSON.parse(json);
check('document survives a JSON round trip',
  reloaded.tables.length === state.state.doc.tables.length &&
  reloaded.relationships.length === state.state.doc.relationships.length &&
  reloaded.annotations.length === state.state.doc.annotations.length);
check('manual positions survive',
  reloaded.tables.every((t, i) => t.x === state.state.doc.tables[i].x && t.y === state.state.doc.tables[i].y));

function balanced(markup) {
  const stack = [];
  const tag = /<(\/?)([a-zA-Z:]+)[^>]*?(\/?)>/g;
  let m;
  while ((m = tag.exec(markup))) {
    if (m[3] === '/') continue;
    if (m[1] === '/') { if (stack.pop() !== m[2]) return false; }
    else stack.push(m[2]);
  }
  return stack.length === 0;
}

console.log('\nConnector anchoring');
const acct = state.state.doc.tables.find(t => t.logicalName === 'account');
const contactTable = state.state.doc.tables.find(t => t.logicalName === 'contact');
state.state.doc.settings.fieldDetail = 'RelationshipFields';
acct.x = 0; acct.y = 0;
contactTable.x = 700; contactTable.y = 0;
geometry.invalidateSizes();

const customerLink = state.state.doc.relationships.find(r => r.schemaName === 'contact_customer_accounts');
customerLink.included = true;
customerLink.routeOffset = 0;

const anchored = geometry.routeRelationship(customerLink, 0, 1);
const contactRect = geometry.tableRect(contactTable);
const fkIndex = contactRect.rows.findIndex(row => row.column.logicalName === 'parentcustomerid');

check('the lookup end points at the lookup column', fkIndex >= 0 &&
  Math.abs(anchored.end.y - (contactRect.y + geometry.METRICS.headerHeight +
    fkIndex * geometry.METRICS.rowHeight + geometry.METRICS.rowHeight / 2)) < 0.01,
  'end.y ' + anchored.end.y);

state.state.doc.settings.fieldDetail = 'TablesOnly';
geometry.invalidateSizes();
const headerOnly = geometry.routeRelationship(customerLink, 0, 1);
check('with no columns drawn, both ends meet the middle of the header',
  Math.abs(headerOnly.start.y - (acct.y + geometry.METRICS.headerHeight / 2)) < 0.01 &&
  Math.abs(headerOnly.end.y - (contactTable.y + geometry.METRICS.headerHeight / 2)) < 0.01,
  headerOnly.start.y + ' / ' + headerOnly.end.y);
check('the header anchor sits above the header bottom edge',
  headerOnly.start.y < acct.y + geometry.METRICS.headerHeight);

state.state.doc.settings.fieldDetail = 'RelationshipFields';
geometry.invalidateSizes();

console.log('\nManual connector offset');
const undragged = geometry.routeRelationship(customerLink, 0, 1);
customerLink.routeOffset = 60;
const dragged = geometry.routeRelationship(customerLink, 0, 1);

check('dragging a connector leaves both end anchors alone',
  undragged.start.x === dragged.start.x && undragged.start.y === dragged.start.y &&
  undragged.end.x === dragged.end.x && undragged.end.y === dragged.end.y);
check('dragging a connector moves the middle of the route',
  JSON.stringify(undragged.points) !== JSON.stringify(dragged.points));
check('the route reports which axis a drag moves it along',
  dragged.offsetAxis === 'x' || dragged.offsetAxis === 'y');
customerLink.routeOffset = 0;

console.log('\nLine jumps at crossings');
const horizontalRun = [{ x: 0, y: 100 }, { x: 400, y: 100 }];
const crossingRun = [{ x: 200, y: 0 }, { x: 200, y: 300 }];
const hops = geometry.crossingPoints(horizontalRun, geometry.segmentsOf(crossingRun));

check('a crossing is detected', hops.length === 1 && hops[0].x === 200 && hops[0].y === 100,
  JSON.stringify(hops));
check('a crossing becomes an arc in the path', /\sA\s/.test(geometry.pathFromPoints(horizontalRun, 8, hops)));
check('no crossing means no arc', !/\sA\s/.test(geometry.pathFromPoints(horizontalRun, 8, [])));
check('a connector does not hop over a line that only touches its end',
  geometry.crossingPoints(horizontalRun, geometry.segmentsOf([{ x: 0, y: 0 }, { x: 0, y: 300 }])).length === 0);

console.log('\nColumn visibility takes effect immediately');
state.state.doc.settings.fieldDetail = 'AllFields';
geometry.invalidateSizes();
const allRows = geometry.measureTable(acct).rows.length;
const hiddenColumn = acct.columns.find(c => c.logicalName === 'name');
hiddenColumn.selected = false;
const fewerRows = geometry.measureTable(acct).rows.length;

check('unticking a column removes its row without a manual cache flush', fewerRows === allRows - 1,
  allRows + ' then ' + fewerRows);

acct.columns.forEach(c => { c.selected = false; });
check('unticking everything is honoured rather than falling back to a column',
  geometry.measureTable(acct).rows.length === 0);
acct.columns.forEach(c => { c.selected = true; });
state.state.doc.settings.fieldDetail = 'RelationshipFields';
geometry.invalidateSizes();

console.log('\nEmphasis and notes on the card');
check('a colour tints towards the card background', geometry.tint('#1f5fe0', 1) === '#ffffff' &&
  geometry.tint('#1f5fe0', 0) === '#1f5fe0', geometry.tint('#1f5fe0', 0.86));
check('a non-colour is passed straight through', geometry.tint(null, 0.5) === null);

acct.notes = 'Owned by the CRM platform team.';
acct.highlight = '#16a34a';
geometry.invalidateSizes();
render.render();
const notedSvg = render.buildExportSvg();
check('a table with a note is labelled on the canvas', notedSvg.includes('NOTE'));
check('emphasis reaches the card header', notedSvg.includes(theme.emphasisHead('#16a34a')));
check('emphasis leaves the card body on its status fill',
  notedSvg.includes('fill="' + geometry.statusStyle('Existing').fill + '"'));
check('the emphasis border keeps the saturated hue', notedSvg.includes('#16a34a'));
// The header tint must be an 86%-towards-white mix of the table colour. That exact look is
// intentional, so it is pinned rather than left to drift.
const legacyHeadTint = hex => '#' + [0, 2, 4]
  .map(i => parseInt(hex.slice(1 + i, 3 + i), 16))
  .map(c => Math.round(c + (255 - c) * 0.86).toString(16).padStart(2, '0'))
  .join('');

check('the light header tint matches the pre-dark-mode formula',
  theme.emphasisHead('#16a34a') === legacyHeadTint('#16a34a'),
  theme.emphasisHead('#16a34a') + ' vs ' + legacyHeadTint('#16a34a'));

// ------------------------------------------------------------------ theme --

console.log('\nThemes');
check('the default theme is light', theme.currentTheme() === 'light');
check('a light status style is the documented one',
  geometry.statusStyle('Existing').fill === '#ffffff');

theme.setTheme('dark');
check('switching changes the palette', theme.palette().name === 'dark');
check('dark cards are drawn on a dark fill',
  geometry.statusStyle('Existing').fill !== '#ffffff');
check('dark card text is light', geometry.statusStyle('Existing').ink !== '#101725');

geometry.invalidateSizes();
render.render();

// The export must never follow the screen palette: it is always drawn light.
const darkExport = render.buildExportSvg();
check('the export stays light in dark mode', darkExport.includes('fill="#ffffff"'));
check('the export uses light card fills', !darkExport.includes('#141924'));
check('the palette is restored after an export', theme.palette().name === 'dark');

theme.setTheme('light');
geometry.invalidateSizes();
check('switching back restores the light palette', theme.palette().name === 'light');

// --------------------------------------------------------- proposed columns --

console.log('\nProposed columns on a real table');
acct.highlight = null;
acct.columns.push({
  id: 'acctproposed', logicalName: 'cs_segmentcode', displayName: 'Segment code',
  typeName: 'Text', isPrimaryId: false, isPrimaryName: false, isLookup: false,
  targets: [], selected: true, status: 'Proposed'
});
geometry.invalidateSizes();
render.render();

const proposedColumnSvg = render.buildExportSvg();
check('a proposed column is drawn on an existing table',
  proposedColumnSvg.includes('cs_segmentcode'));
check('a proposed column is marked with more than colour',
  proposedColumnSvg.includes('#dda93a'));

state.state.doc.settings.fieldDetail = 'TablesOnly';
geometry.invalidateSizes();
check('a proposed column still respects the detail level',
  geometry.measureTable(acct).rows.length === 0);
state.state.doc.settings.fieldDetail = 'RelationshipFields';
geometry.invalidateSizes();

acct.columns = acct.columns.filter(c => c.id !== 'acctproposed');
geometry.invalidateSizes();

// ------------------------------------------------------------------ notes --

console.log('\nResizable notes');
state.mutate('note', () => {
  state.state.doc.annotations.push({
    id: 'n1', text: 'Design decision', x: 40, y: 40, width: 240, height: 96,
    fontSize: 12, bold: false, background: '#fff8e1', border: '#e8d9a8', attachedToId: null
  });
});
render.render();

// The resize grip is a control of the selection: it is drawn only on a selected annotation, so an
// unselected box can be dragged by its corner without being reshaped.
//
// The hit rectangle and the two diagonal marks are one control and are gated together. Counted
// separately here because gating only the rectangle would leave the marks on every note, and
// gating only the marks would leave an invisible resize zone in every corner.
const gripRects = svgText => (svgText.match(/data-resize="annotation"/g) || []).length;
// Counted by class rather than by colour: the rotation handle draws its stem on the same note in
// the same selection colour, so counting every selection-coloured line would over-count.
const gripMarks = svgText => (svgText.match(/class="resize-mark"/g) || []).length;

check('an unselected note has no resize grip',
  !annotationMarkup().includes('data-resize="annotation"'));
check('and none of the marks that advertise one',
  gripMarks(annotationMarkup()) === 0,
  gripMarks(annotationMarkup()) + ' marks');

state.selectOnly('annotations', 'n1');
render.render();

check('a note has a resize grip on screen once it is selected',
  annotationMarkup().includes('data-resize="annotation"'));
check('and the marks that show where it is - one pair per grip, and none anywhere else',
  gripRects(annotationMarkup()) > 0 &&
  gripMarks(annotationMarkup()) ===
    gripRects(annotationMarkup()) * 2,
  gripMarks(annotationMarkup()) + ' marks for ' +
  gripRects(annotationMarkup()) + ' grips');
check('the grip is left out of exports',
  !render.buildExportSvg().includes('data-resize'));
check('and so are its marks, which are part of the selection rather than of the drawing',
  gripMarks(render.buildExportSvg()) === 0, gripMarks(render.buildExportSvg()) + ' marks');
check('a note cannot be resized below a usable size',
  render.MIN_NOTE_WIDTH > 0 && render.MIN_NOTE_HEIGHT > 0);

// A note attached to a connector draws a leader line to it.
//
// Counted rather than tested for presence, because the note's own resize grip is drawn from two
// short lines. The leader line is the difference between attached and not.
const lineCount = () => (annotationMarkup().match(/<line /g) || []).length;

state.state.doc.annotations[0].attachedToId = null;
render.render();
const unattachedLines = lineCount();

state.state.doc.annotations[0].attachedToId = acct.id;
render.render();
check('a note attached to a table draws a leader line', lineCount() === unattachedLines + 1);

state.state.doc.annotations[0].attachedToId = state.state.doc.relationships[0].id;
render.render();
check('a note attached to a relationship draws a leader line too',
  lineCount() === unattachedLines + 1);

state.state.doc.annotations[0].attachedToId = 'no-such-object';
render.render();
check('a note attached to something that has gone draws no leader line',
  lineCount() === unattachedLines);

state.state.doc.annotations[0].attachedToId = null;

console.log('\nOwnership overlay');

acct.ownershipType = 'UserOwned';
state.state.doc.settings.showOwnership = false;
geometry.invalidateSizes();
render.render();
check('ownership is not drawn when the toggle is off',
  !serialiseLayer('layer-tables').includes('USER'));

const narrow = geometry.measureTable(acct).width;

state.state.doc.settings.showOwnership = true;
geometry.invalidateSizes();
render.render();
check('ownership is drawn when the toggle is on',
  serialiseLayer('layer-tables').includes('USER'));
check('the card is widened to fit the marker rather than truncating the title',
  geometry.measureTable(acct).width >= narrow);

acct.ownershipType = 'OrganizationOwned';
geometry.invalidateSizes();
render.render();
check('organisation ownership is marked differently',
  serialiseLayer('layer-tables').includes('ORG'));

// A proposed table has no ownership until somebody creates it, so it must not claim one. Driven
// off a table this test controls, so the check always runs rather than depending on run order.
acct.ownershipType = 'UserOwned';
acct.status = 'Proposed';
geometry.invalidateSizes();
render.render();
check('a proposed table is not given an ownership marker',
  !serialiseLayer('layer-tables').includes('USER'));

acct.status = 'Existing';
acct.ownershipType = 'OrganizationOwned';
geometry.invalidateSizes();
render.render();

check('the exported drawing carries the marker too',
  render.buildExportSvg().includes('ORG'));

acct.ownershipType = null;
state.state.doc.settings.showOwnership = false;
geometry.invalidateSizes();

console.log('\nRegression checks');

// The path finder sets highlightPath and closes its dialog without selecting anything. dimming()
// must honour highlightPath even when the selection is empty.
state.clearSelection();
state.state.highlightPath = { tables: new Set([acct.id]), relationships: new Set() };
render.render();
const dimmedWithNoSelection = serialiseLayer('layer-tables').includes('opacity');
check('a path highlight dims the canvas with nothing selected', dimmedWithNoSelection);

state.state.highlightPath = null;
render.render();
check('no highlight means nothing is dimmed',
  !serialiseLayer('layer-tables').includes('opacity="0.'));

// The cardinality toggle controls the crow's feet as well as the text label.
state.state.doc.settings.showCardinality = true;
render.render();
const withFeet = serialiseLayer('layer-links');
state.state.doc.settings.showCardinality = false;
render.render();
const withoutFeet = serialiseLayer('layer-links');
check('turning off cardinality removes the crow\'s-foot terminators',
  withFeet.length > withoutFeet.length, withFeet.length + ' vs ' + withoutFeet.length);
state.state.doc.settings.showCardinality = true;

// showFieldSchemaName takes effect on its own, without showFieldDisplayName also being on (which
// is off by default).
state.state.doc.settings.fieldDetail = 'AllFields';
state.state.doc.settings.showFieldDisplayName = false;
state.state.doc.settings.showFieldSchemaName = true;
geometry.invalidateSizes();
const schemaLabel = geometry.columnLabel(acct.columns[0]);
state.state.doc.settings.showFieldSchemaName = false;
state.state.doc.settings.showFieldDisplayName = true;
geometry.invalidateSizes();
const displayLabel = geometry.columnLabel(acct.columns[0]);
check('the two column-name toggles select different text independently',
  schemaLabel.primary !== displayLabel.primary || !schemaLabel.secondary,
  schemaLabel.primary + ' vs ' + displayLabel.primary);

state.state.doc.settings.showFieldDisplayName = true;
state.state.doc.settings.showFieldSchemaName = true;
geometry.invalidateSizes();
const bothLabel = geometry.columnLabel(acct.columns.find(c => c.displayName && c.logicalName &&
  c.displayName.toLowerCase() !== c.logicalName.toLowerCase()) || acct.columns[0]);
check('both toggles on offers a secondary name to draw', bothLabel.secondary !== undefined);
state.state.doc.settings.showFieldDisplayName = false;
state.state.doc.settings.showFieldSchemaName = true;
state.state.doc.settings.fieldDetail = 'RelationshipFields';
geometry.invalidateSizes();

// Auto and Horizontal are distinct layouts.
layout.applyLayout('Auto');
const autoPositions = state.state.doc.tables.map(t => t.x + ',' + t.y).join('|');
layout.applyLayout('Horizontal');
const horizontalPositions = state.state.doc.tables.map(t => t.x + ',' + t.y).join('|');
check('Auto and Horizontal are genuinely different layouts',
  autoPositions !== horizontalPositions);
layout.applyLayout('Auto');

// An existing column can be marked deprecated from the UI; storage, rendering and every exporter
// understand the flag.
const deprecatedColumn = acct.columns.find(c => !c.isPrimaryId) || acct.columns[0];
const previousStatus = deprecatedColumn.status;
deprecatedColumn.status = 'Deprecated';
deprecatedColumn.selected = true;
state.state.doc.settings.fieldDetail = 'AllFields';
geometry.invalidateSizes();
render.render();
check('a deprecated column is struck through on the card',
  serialiseLayer('layer-tables').includes('line-through'));
deprecatedColumn.status = previousStatus;
state.state.doc.settings.fieldDetail = 'RelationshipFields';

acct.notes = '';
acct.highlight = null;
geometry.invalidateSizes();

// ------------------------------------------------ proposed rows, notes, legend ----

console.log('\nCards, notes and the legend');

// A proposed column gets the proposed card's own tint behind its row, at every table status, so
// it stands out on a card of many real columns.
const proposedColumn = {
  id: 'acct-proposed', logicalName: 'cs_segment', schemaName: 'cs_Segment',
  displayName: 'Segment', typeName: 'Choice', attributeType: 'Picklist',
  isPrimaryId: false, isPrimaryName: false, isLookup: false, targets: [],
  selected: true, status: 'Proposed'
};

acct.columns.push(proposedColumn);
geometry.invalidateSizes();
render.render();

const proposedFill = theme.palette().status.Proposed.head;
check('a proposed column is drawn on a tinted row',
  serialiseLayer('layer-tables').includes('fill="' + proposedFill + '"'));

// The tint has to survive an export. The export is always light, so the light palette's tint is
// what to look for.
check('the tint reaches the exported drawing',
  render.buildExportSvg().includes('fill="#fff4dc"'));

acct.columns = acct.columns.filter(c => c.id !== proposedColumn.id);
geometry.invalidateSizes();

// Clicking the NOTE tag on a card opens the note on the canvas. It is transient view state, so it
// must never reach an export.
acct.notes = 'Segmentation is owned by the CRM workstream, not by Finance.';
geometry.invalidateSizes();
render.render();
check('the note tag is clickable',
  serialiseLayer('layer-tables').includes('data-note-for="' + acct.id + '"'));

state.state.openNote = acct.id;
render.render();
const openNote = serialiseLayer('layer-overlay');
check('clicking it opens the note on the canvas', openNote.includes('Segmentation is owned'));
check('the open note carries a close control', openNote.includes('data-note-close="' + acct.id + '"'));
check('an open note is not part of the export',
  !render.buildExportSvg().includes('Segmentation is owned'));

// The tag itself is drawn inverted - white on the tag's own line colour - while its note is open.
// That is a control's state, so an export taken with a note open must draw every tag normally.
{
  state.state.openNote = acct.id;
  const withNoteOpen = render.buildExportSvg();

  state.state.openNote = null;
  const withNoteClosed = render.buildExportSvg();

  check('an open note does not change how the exported tag is drawn',
    withNoteOpen === withNoteClosed);
  check('the tag\'s tooltip - an instruction to click it - is left out of the export',
    !withNoteOpen.includes('this note'));

  state.state.openNote = acct.id;
}

// A note whose table has gone drops itself rather than drawing against a missing card.
state.state.openNote = 'no-such-table';
render.render();
check('an open note for a table that has gone clears itself',
  state.state.openNote === null && serialiseLayer('layer-overlay').length < 60);

state.state.openNote = null;
acct.notes = '';
geometry.invalidateSizes();

// The legend lists hand-applied emphasis colours as well as the statuses, so it describes
// everything on the page.
acct.highlight = '#0f7b8a';
check('an emphasis colour falls back to its hue name', theme.emphasisName('#0f7b8a') === 'Teal');

state.mutate('name colour', () => {
  state.state.doc.settings.emphasisNames = { '#0f7b8a': 'Phase 2' };
});
check('a named emphasis colour uses the name', theme.emphasisName('#0f7b8a') === 'Phase 2');

render.render();
const legendSvg = render.buildExportSvg();
check('the exported legend lists the emphasis colours in use', legendSvg.includes('Phase 2'));

// An unnamed colour is not silently dropped from the legend.
delete state.state.doc.settings.emphasisNames;
check('an unnamed emphasis colour still appears in the legend',
  render.buildExportSvg().includes('Teal'));

acct.highlight = null;
geometry.invalidateSizes();

// The tick list in the table inspector says what is on the card, so it must be read from the same
// function the renderer uses - `selected` is permission to draw rather than proof of drawing, and
// in the default detail mode the two differ.
state.state.doc.settings.fieldDetail = 'RelationshipFields';
geometry.invalidateSizes();
const drawnNow = geometry.visibleColumns(acct).map(c => c.id);
const permittedNow = acct.columns.filter(c => c.selected !== false).map(c => c.id);
check('what is drawn is a strict subset of what is permitted, so the two are not interchangeable',
  drawnNow.length < permittedNow.length && drawnNow.every(id => permittedNow.includes(id)),
  drawnNow.length + ' drawn of ' + permittedNow.length + ' permitted');

// Seeding the ticks from the card is only safe from a mode that actually draws a card. From
// "Table name only" - or from a collapsed card - nothing is drawn, and writing that empty set into
// the `selected` flags unticks every column. It is not just wrong for that one switch: it cannot
// be undone by changing the detail level back, because visibleColumns filters on `selected` before
// it applies any relationship rule and before the never-show-an-empty-card fallback. The table
// draws nothing, at any detail level, for ever.
{
  const inspectorModule = await import(js + 'inspector.js');
  const before = acct.columns.map(c => c.selected !== false);

  // From relationship columns, the seed is the whole point: the card does not change at the moment
  // of switching, so the next tick adds one column rather than forty.
  acct.detailOverride = 'RelationshipFields';
  geometry.invalidateSizes();
  const cardBefore = geometry.visibleColumns(acct).map(c => c.id).join(',');

  inspectorModule.seedFromCard(acct);
  acct.detailOverride = 'AllFields';
  geometry.invalidateSizes();

  check('seeding from a relationship-columns card keeps exactly that card',
    geometry.visibleColumns(acct).map(c => c.id).join(',') === cardBefore,
    geometry.visibleColumns(acct).length + ' vs ' + cardBefore.split(',').length);

  acct.columns.forEach((c, i) => { c.selected = before[i]; });

  // From tables-only, or from a collapsed card, nothing is drawn - and seeding from that empty set
  // would untick every column. Unrecoverably: visibleColumns filters on `selected` before it
  // applies any relationship rule and before the never-show-an-empty-card fallback, so the table
  // would draw nothing at any detail level ever again.
  acct.detailOverride = 'TablesOnly';
  geometry.invalidateSizes();
  check('a tables-only card draws nothing, which is what makes it a trap',
    geometry.visibleColumns(acct).length === 0);

  inspectorModule.seedFromCard(acct);
  acct.detailOverride = 'AllFields';
  geometry.invalidateSizes();

  check('switching a tables-only card to all-fields still draws its columns',
    geometry.visibleColumns(acct).length > 0,
    geometry.visibleColumns(acct).length + ' columns');

  acct.collapsed = true;
  inspectorModule.seedFromCard(acct);
  acct.collapsed = false;
  acct.detailOverride = 'RelationshipFields';
  geometry.invalidateSizes();
  check('and a collapsed card is not wiped either',
    geometry.visibleColumns(acct).length > 0);

  check('no column was silently unticked by any of that',
    acct.columns.every((c, i) => (c.selected !== false) === before[i]));

  acct.detailOverride = null;
  geometry.invalidateSizes();

  // Ticking a column the current detail level would not draw. From a card showing nothing at all,
  // "add this one" means this one - not "switch to all selected columns and keep every tick
  // standing".
  acct.detailOverride = 'TablesOnly';
  geometry.invalidateSizes();

  const wanted = acct.columns.find(c => !c.isPrimaryId && !c.isLookup) || acct.columns[0];
  const switched = inspectorModule.addColumnToCard(acct, wanted);
  geometry.invalidateSizes();

  const nowDrawn = geometry.visibleColumns(acct);
  check('ticking a column on a card showing nothing says the table changed level', switched === true);
  check('and puts exactly that one column on it',
    nowDrawn.length === 1 && nowDrawn[0].id === wanted.id,
    nowDrawn.length + ' columns: ' + nowDrawn.map(c => c.logicalName).join(', '));

  // A second tick, now that the table is already on all-selected-columns, just adds to the card.
  const alsoWanted = acct.columns.find(c => c.id !== wanted.id);
  const switchedAgain = inspectorModule.addColumnToCard(acct, alsoWanted);
  geometry.invalidateSizes();

  check('a second tick adds one more rather than switching anything', switchedAgain === false);
  check('and the card is now the two of them',
    geometry.visibleColumns(acct).length === 2,
    geometry.visibleColumns(acct).length + ' columns');

  acct.detailOverride = null;
  acct.columns.forEach((c, i) => { c.selected = before[i]; });
  geometry.invalidateSizes();
}

// ------------------------------------------------ connectors and lookups ----

console.log('\nThe crow\'s foot points the right way');

// The many terminator is a crow's foot: the prongs touch the entity because they are the many
// records, and the apex is out on the connector - not an arrowhead pointing into the table.
{
  state.state.doc.settings.showCardinality = true;
  render.render();

  const links = serialiseLayer('layer-links');

  check('the many terminator fans out onto the card',
    links.includes('M 0 -5 L 11 0 L 0 5'));
  check('its middle prong reaches the card too, rather than stopping a unit short',
    links.includes('x1="0" y1="0" x2="11" y2="0"'));
  check('the inward-pointing arrowhead it used to be is gone',
    !links.includes('M 11 -5 L 1 0 L 11 5'));
}

console.log('\nA proposed relationship writes its own lookup column');

{
  const oneEnd = state.state.doc.tables.find(t => t.logicalName === 'account');
  const manyEnd = state.state.doc.tables.find(t => t.logicalName === 'cs_territory');
  const otherMany = state.state.doc.tables.find(t => t.logicalName === 'quote');

  // Placed so the route is horizontal, which is the case where an end anchor is a row on the card
  // rather than a point on its top or bottom edge.
  oneEnd.x = 0; oneEnd.y = 0;
  manyEnd.x = 700; manyEnd.y = 0;

  const proposedLink = {
    id: 'r-proposed-lookup',
    schemaName: 'cs_account_territory_owner',
    kind: 'OneToMany',
    status: 'Proposed',
    fromTableId: oneEnd.id,
    toTableId: manyEnd.id,
    referencingAttribute: '',
    included: true, hidden: false, highlight: null, waypoints: [], notes: ''
  };

  state.mutate('propose relationship', () => {
    state.state.doc.relationships.push(proposedLink);
    state.syncProposedLookupColumn(proposedLink);
  });
  geometry.invalidateSizes();

  const created = (manyEnd.columns || []).find(c => c.fromRelationshipId === proposedLink.id);

  check('the lookup column is created on the table at the many end', !!created);
  check('it is a proposed lookup',
    !!created && created.isLookup === true && created.status === 'Proposed' &&
    created.typeName === 'Lookup');
  check('it is named after the table at the one end when no name was given',
    !!created && created.logicalName === 'accountid', created && created.logicalName);
  check('the relationship and the column agree on that name',
    !!created && proposedLink.referencingAttribute === created.logicalName);
  check('the lookup says which table it points at',
    !!created && (created.targets || []).includes('account'));
  check('the one end is anchored to its primary key',
    proposedLink.referencedAttribute === 'accountid', proposedLink.referencedAttribute);

  // The point of creating the column is that the connector has something to land on, so the diagram
  // says which field holds the relationship rather than meeting the middle of the card header.
  render.render();

  const manyRect = geometry.tableRect(manyEnd);
  const rowIndex = manyRect.rows.findIndex(row => row.column.logicalName === 'accountid');
  const rowCentre = manyRect.y + geometry.METRICS.headerHeight +
                    rowIndex * geometry.METRICS.rowHeight + geometry.METRICS.rowHeight / 2;

  const route = geometry.routeRelationship(proposedLink, 0, 1);

  check('the new column is drawn on the card', rowIndex >= 0,
    manyRect.rows.map(r => r.column.logicalName).join(','));
  check('the connector lands on the lookup row rather than the card header',
    rowIndex >= 0 && route && Math.abs(route.end.y - rowCentre) < 0.5,
    route && route.end.y + ' vs ' + rowCentre);

  state.mutate('rename the lookup', () => {
    proposedLink.referencingAttribute = 'cs_owningaccountid';
    state.syncProposedLookupColumn(proposedLink);
  });
  geometry.invalidateSizes();

  check('renaming the lookup renames the column rather than adding a second',
    (manyEnd.columns || []).filter(c => c.fromRelationshipId === proposedLink.id).length === 1 &&
    created.logicalName === 'cs_owningaccountid');

  state.mutate('move the many end', () => {
    proposedLink.toTableId = otherMany.id;
    state.syncProposedLookupColumn(proposedLink);
  });

  check('changing the many end moves the column instead of leaving one behind',
    !(manyEnd.columns || []).some(c => c.fromRelationshipId === proposedLink.id) &&
    (otherMany.columns || []).some(c => c.fromRelationshipId === proposedLink.id));

  state.mutate('make it many to many', () => {
    proposedLink.kind = 'ManyToMany';
    state.syncProposedLookupColumn(proposedLink);
  });

  check('a many-to-many has no lookup, so switching to one takes the column away',
    !state.state.doc.tables.some(t =>
      (t.columns || []).some(c => c.fromRelationshipId === proposedLink.id)));

  state.mutate('back to one to many', () => {
    proposedLink.kind = 'OneToMany';
    proposedLink.toTableId = manyEnd.id;
    state.syncProposedLookupColumn(proposedLink);
  });

  check('switching back puts it there again',
    (manyEnd.columns || []).some(c => c.fromRelationshipId === proposedLink.id));

  state.mutate('remove the relationship', () => state.removeRelationship(proposedLink.id));
  geometry.invalidateSizes();

  check('removing the relationship removes the lookup column it created',
    !state.state.doc.tables.some(t =>
      (t.columns || []).some(c => c.fromRelationshipId === proposedLink.id)));

  // A real column of that name means the design is describing something that already exists. A
  // second row with the same logical name would draw the same field twice on one card.
  const contactCard = state.state.doc.tables.find(t => t.logicalName === 'contact');
  const realColumns = (contactCard.columns || []).filter(c => c.logicalName === 'parentcustomerid').length;

  const adopting = {
    id: 'r-proposed-adopt', schemaName: 'cs_adopt', kind: 'OneToMany', status: 'Proposed',
    fromTableId: oneEnd.id,
    toTableId: contactCard.id,
    referencingAttribute: 'parentcustomerid',
    included: true, hidden: false, highlight: null, waypoints: [], notes: ''
  };

  state.mutate('propose over a real column', () => {
    state.state.doc.relationships.push(adopting);
    state.syncProposedLookupColumn(adopting);
  });

  check('a real column of that name is adopted rather than duplicated',
    (contactCard.columns || []).filter(c => c.logicalName === 'parentcustomerid').length === realColumns,
    String((contactCard.columns || []).filter(c => c.logicalName === 'parentcustomerid').length));
  check('and it is left as Dataverse metadata rather than restyled as a proposal',
    (contactCard.columns || []).find(c => c.logicalName === 'parentcustomerid').status === 'Existing');

  state.mutate('tidy up', () => state.removeRelationship(adopting.id));

  check('removing that relationship leaves the real column alone',
    (contactCard.columns || []).some(c => c.logicalName === 'parentcustomerid'));

  // Deleting a table takes its connectors, and each connector has to take its lookup column with
  // it - the column sits on the table at the *other* end, which is usually one that is staying.
  const survivor = otherMany;

  const cascading = {
    id: 'r-proposed-cascade', schemaName: 'cs_cascade', kind: 'OneToMany', status: 'Proposed',
    fromTableId: manyEnd.id, toTableId: survivor.id, referencingAttribute: 'cs_territoryid',
    included: true, hidden: false, highlight: null, waypoints: [], notes: ''
  };

  state.mutate('propose from the table about to go', () => {
    state.state.doc.relationships.push(cascading);
    state.syncProposedLookupColumn(cascading);
  });

  check('the column is on the surviving table, not the one being deleted',
    (survivor.columns || []).some(c => c.fromRelationshipId === cascading.id));

  state.mutate('remove the table at the one end', () => state.removeTable(manyEnd.id));
  geometry.invalidateSizes();

  check('deleting a table takes the lookup its relationships put on other cards',
    !(survivor.columns || []).some(c => c.fromRelationshipId === cascading.id));
}

console.log('\nThe size cache answers for the card that is actually there');

{
  // Two inputs that change the measured width of a card must be in the size cache key rather than
  // left to every caller to flush by hand. Status is one - a non-existing card reserves 62px for its
  // badge, and only an existing or deprecated one gets an ownership pill. Column names are the
  // other: undo swaps in a clone, so a rename comes back without anyone calling invalidateSizes.
  const probe = {
    id: 'probe-card', logicalName: null, schemaName: 'cs_probe', displayName: 'Probe',
    status: 'Existing', x: -900, y: -900, collapsed: false, detailOverride: 'AllFields',
    highlight: null, notes: '', alternateKeys: [],
    columns: [{
      id: 'probe-col', logicalName: 'cs_code', schemaName: 'cs_Code', displayName: 'Code',
      typeName: 'Text', isPrimaryId: false, isPrimaryName: false, isLookup: false,
      targets: [], selected: true, status: 'Existing'
    }]
  };

  state.state.doc.tables.push(probe);
  geometry.invalidateSizes();

  const asExisting = geometry.measureTable(probe).width;
  probe.status = 'Proposed';
  const asProposed = geometry.measureTable(probe).width;

  check('a status change re-measures the card without a manual cache flush',
    asProposed !== asExisting, asExisting + ' then ' + asProposed);

  probe.status = 'Existing';
  geometry.measureTable(probe);

  // Undo does not edit the columns in place - it swaps in a clone of the whole document, so the
  // column objects are replaced with the same count, ticks and relationships. The card must still
  // draw the restored name. Mutating the existing object instead would not show it, because the
  // cached row holds a reference to it.
  probe.columns = [Object.assign({}, probe.columns[0], {
    logicalName: 'cs_a_considerably_longer_column_name'
  })];

  const afterSwap = geometry.measureTable(probe).rows[0].column.logicalName;

  check('a wholesale column swap - which is what undo does - re-measures the card too',
    afterSwap === 'cs_a_considerably_longer_column_name', afterSwap);

  state.state.doc.tables = state.state.doc.tables.filter(t => t.id !== probe.id);
  geometry.invalidateSizes();
}

console.log('\nA lookup column outlives the proposal that made it');

{
  const one = state.state.doc.tables.find(t => t.logicalName === 'account');
  const many = state.state.doc.tables.find(t => t.logicalName === 'opportunity');

  const link = {
    id: 'r-release', schemaName: 'cs_release', kind: 'OneToMany', status: 'Proposed',
    fromTableId: one.id, toTableId: many.id, referencingAttribute: 'cs_secondaryaccountid',
    included: true, hidden: false, highlight: null, waypoints: [], notes: ''
  };

  state.mutate('propose', () => {
    state.state.doc.relationships.push(link);
    state.syncProposedLookupColumn(link);
  });

  // Marking the proposal as existing must not delete the lookup: the user has just said the lookup
  // is there. The column must also stay editable and removable through the UI.
  state.mutate('mark existing', () => {
    link.status = 'Existing';
    state.syncProposedLookupColumn(link);
  });

  const settled = (many.columns || []).find(c => c.logicalName === 'cs_secondaryaccountid');

  check('the column stays on the card', !!settled);
  check('it takes the relationship\'s new status',
    !!settled && settled.status === 'Existing', settled && settled.status);

  // The link back to the relationship is kept, so that proposing the relationship again finds its
  // own column rather than leaving the settled one behind and making a second row with the same name.
  state.mutate('propose it again', () => {
    link.status = 'Proposed';
    state.syncProposedLookupColumn(link);
  });

  const reclaimed = (many.columns || []).filter(c => c.logicalName === 'cs_secondaryaccountid');

  check('proposing the relationship again takes its column back rather than making a second',
    reclaimed.length === 1, String(reclaimed.length));
  check('and the column is a proposal again',
    reclaimed.length === 1 && reclaimed[0].status === 'Proposed' &&
    reclaimed[0].fromRelationshipId === link.id);

  // A settled column is nobody's once the connector has gone, so the ordinary column controls -
  // which refuse to touch a column owned by a live proposal - apply to it again.
  state.mutate('settle and delete the connector', () => {
    link.status = 'Existing';
    state.syncProposedLookupColumn(link);
    state.removeRelationship(link.id);
  });

  const orphan = (many.columns || []).find(c => c.logicalName === 'cs_secondaryaccountid');

  check('deleting a settled relationship leaves its column, unowned',
    !!orphan && !orphan.fromRelationshipId && orphan.status === 'Existing');

  state.mutate('tidy', () => {
    many.columns = (many.columns || []).filter(c => c.logicalName !== 'cs_secondaryaccountid');
  });

  // Renaming a lookup onto a name the card already carries must not produce two rows with the same
  // logical name. rowCentreY matches the first by name, so the connector would land on one of them
  // while the duplicate sat below it.
  const clash = {
    id: 'r-clash', schemaName: 'cs_clash', kind: 'OneToMany', status: 'Proposed',
    fromTableId: one.id, toTableId: many.id, referencingAttribute: 'cs_temp',
    included: true, hidden: false, highlight: null, waypoints: [], notes: ''
  };

  state.mutate('propose', () => {
    state.state.doc.relationships.push(clash);
    state.syncProposedLookupColumn(clash);
  });

  state.mutate('rename onto the real lookup', () => {
    clash.referencingAttribute = 'customerid';
    state.syncProposedLookupColumn(clash);
  });

  const named = (many.columns || []).filter(c =>
    String(c.logicalName || '').toLowerCase() === 'customerid');

  check('renaming a lookup onto a column the card already has does not draw it twice',
    named.length === 1, String(named.length));
  check('and the column it collided with is left as it was',
    named.length === 1 && named[0].status === 'Existing' && !named[0].fromRelationshipId);
  check('the relationship no longer carries a column of its own',
    !state.state.doc.tables.some(t => (t.columns || []).some(c => c.fromRelationshipId === clash.id)));

  state.mutate('tidy', () => state.removeRelationship(clash.id));
  geometry.invalidateSizes();
}

console.log('\nLookups are designed in the relationship editor, not the column editor');

{
  const proposedModule = await import(js + 'proposed.js');
  const offered = proposedModule.typeOptionsFor({}).map(option => option.value);

  check('the column editor offers no lookup types',
    !offered.includes('Lookup') && !offered.includes('Customer') && !offered.includes('Owner'),
    offered.join(','));
  check('it still offers ordinary types', offered.includes('Text') && offered.includes('Choice'));

  // Dropping a value from a select does not leave the control blank - it falls back to the first
  // option. So the type list for an existing lookup must include Lookup, or opening it only to read
  // it would retype it to whatever is first in the list.
  const forExisting = proposedModule.typeOptionsFor({ typeName: 'Lookup' }).map(o => o.value);

  check('a column that already is a lookup keeps its type in the list',
    forExisting[0] === 'Lookup', forExisting.slice(0, 3).join(','));
}

console.log('\nThe path finder puts the usable answers first');

{
  const dialogsModule = await import(js + 'dialogs.js');

  const ranked = dialogsModule.rankPaths([
    { steps: [{ table: 'account' }, { table: 'nowhere' }, { table: 'contact' }] },
    { steps: [{ table: 'account' }, { table: 'contact' }] },
    { steps: [{ table: 'account' }, { table: 'opportunity' }] }
  ]);

  check('a path whose tables are all on the diagram is listed first',
    ranked[0].onCanvas && ranked[1].onCanvas && !ranked[2].onCanvas,
    ranked.map(r => r.onCanvas).join(','));
  check('and the order the host returned survives inside each group',
    ranked[0].index === 1 && ranked[1].index === 2, ranked.map(r => r.index).join(','));
}

console.log('\nSticky notes, text boxes and arrows');

{
  // Files saved before tool 1.6.0 have no annotation kind; they are all sticky notes, so a missing
  // kind reads as a sticky note.
  check('an annotation with no kind is a sticky note',
    state.annotationKind({ id: 'legacy' }) === 'note');
  check('an unrecognised kind is one too', state.annotationKind({ kind: 'nonsense' }) === 'note');

  state.state.doc.annotations.length = 0;

  const sticky = state.newAnnotation('note', { x: 40, y: 40 });
  const textBox = state.newAnnotation('text', { x: 40, y: 320 });
  const arrow = state.newAnnotation('arrow', { x: 500, y: 500 }, { dx: -120, dy: -80, ink: '#c0392f' });

  sticky.text = 'Owned by the CRM workstream';
  textBox.text = 'Phase 2 scope';

  state.mutate('draw', () => {
    state.state.doc.annotations.push(sticky, textBox, arrow);
  });

  state.clearSelection();
  render.render();
  const drawn = annotationMarkup();

  // Square corners and a tilt are the whole of "a piece of paper stuck onto the drawing".
  check('a sticky note has square corners', drawn.includes('rx="0"'));
  check('a sticky note is tilted', /rotate\(-?[\d.]+,/.test(drawn));
  check('the tilt is stable across renders - one that twitched on every redraw would be worse',
    (() => {
      const first = /rotate\((-?[\d.]+),/.exec(drawn);
      render.render();
      const second = /rotate\((-?[\d.]+),/.exec(annotationMarkup());
      return !!first && !!second && first[1] === second[1];
    })());

  check('a text box draws its text', drawn.includes('Phase 2 scope'));
  check('a text box has something to click even though it has no fill',
    drawn.includes('fill="transparent"'));

  const exported = render.buildExportSvg();
  check('the text box reaches the export', exported.includes('Phase 2 scope'));
  check('its invisible hit rectangle does not',
    !exported.includes('fill="transparent"'));
  // Word by word: the note is 180 units wide, so its text wraps and the whole sentence never
  // appears as one string in the markup.
  check('the sticky note reaches the export', exported.includes('workstream'));
  check('no interaction attributes survive the export',
    !exported.includes('data-resize') && !exported.includes('data-arrow'));

  // An arrow is a start point and a vector, and the vector can be negative in both axes. Every
  // caller that needs to know where annotations are has to go through annotationRect, or an arrow
  // drawn up and to the left falls outside Fit, outside the export bounds and outside a marquee.
  const rect = geometry.annotationRect(arrow);
  check('an arrow drawn up and to the left still has a positive rectangle',
    rect.x === 380 && rect.y === 420 && rect.width === 120 && rect.height === 80,
    JSON.stringify(rect));

  const bounds = geometry.documentBounds(0);
  check('the document bounds contain the head of that arrow',
    bounds.x <= 380 && bounds.y <= 420);

  // The handles are a control on a selected object, so they must not reach an export - and the
  // export clears the selection, which is what makes that true rather than hoped for.
  state.selectOnly('annotations', arrow.id);
  render.render();

  const withHandles = annotationMarkup();
  check('a selected arrow offers a handle at each end',
    withHandles.includes('data-arrow-start') && withHandles.includes('data-arrow-end'));

  state.clearSelection();
  render.render();
  check('an unselected one offers none',
    !annotationMarkup().includes('data-arrow-start'));

  state.state.doc.annotations.length = 0;
  render.render();
}

// ------------------------------------------------------- interaction ----
//
// Everything above tests the canvas by calling into it. This drives it the way a user does, by
// dispatching real pointer and keyboard events at the handlers interact.js registered, so the hit
// testing, the drag state machine, the snap arithmetic and the undo commits are all exercised
// rather than assumed.

console.log('\nThe draw tools, driven by pointer events');

{
  const interactions = await import(js + 'interact.js');
  const uiModule = await import(js + 'ui.js');

  const canvasNode = document.getElementById('canvas');
  const placed = [];

  interactions.initInteractions({
    onSelectionChange: () => {},
    onContextMenu: () => {},
    onOpenEditor: () => {},
    onConnect: () => {},
    onAnnotationPlaced: annotation => placed.push(annotation.id)
  });

  const nowhere = { closest: () => null, tagName: 'svg' };

  const pointer = (type, x, y, options) => {
    const event = Object.assign({
      type, pointerId: 1, clientX: x, clientY: y, button: 0,
      shiftKey: false, ctrlKey: false, altKey: false,
      target: nowhere,
      preventDefault() {}, stopPropagation() {}
    }, options || {});

    for (const handler of (canvasNode.listeners[type] || []).slice()) handler(event);
  };

  const key = (name, options) => {
    window.dispatchEvent(Object.assign({
      type: 'keydown', key: name, code: name === ' ' ? 'Space' : 'Key' + name,
      ctrlKey: false, metaKey: false, shiftKey: false,
      target: { tagName: 'DIV' },
      preventDefault() {}
    }, options || {}));
  };

  const findNode = (root, predicate) => {
    for (const child of root.childNodes) {
      if (predicate(child)) return child;
      const deeper = findNode(child, predicate);
      if (deeper) return deeper;
    }
    return null;
  };

  const withAttribute = name =>
    findNode(document.getElementById('layer-annotations-front'),
      node => node.hasAttribute && node.hasAttribute(name)) ||
    findNode(document.getElementById('layer-annotations'),
      node => node.hasAttribute && node.hasAttribute(name));

  const annotations = () => state.state.doc.annotations;
  const newest = () => annotations()[annotations().length - 1];

  state.state.doc.annotations.length = 0;
  state.clearSelection();
  render.render();

  // ---- placing a sticky note

  interactions.startDrawMode('note');

  check('arming the sticky note tool turns the mode on', interactions.isDrawing());
  check('and says so on screen rather than silently changing what a click means',
    /sticky note/i.test(document.getElementById('connect-banner').textContent));

  pointer('pointerdown', 500, 400);
  pointer('pointerup', 500, 400);

  const note = newest();
  const noteWorld = interactions.toWorld(500, 400);

  check('one click places a sticky note', annotations().length === 1 && state.annotationKind(note) === 'note');
  check('centred on the click rather than hanging down and right of it',
    Math.abs((note.x + note.width / 2) - noteWorld.x) <= 8,
    note.x + '+' + note.width / 2 + ' vs ' + noteWorld.x);
  check('the tool disarms once it has placed one', !interactions.isDrawing());
  check('the note is selected, so the inspector opens on it',
    state.state.selection.annotations.has(note.id));
  check('and the placement is handed on, which is what sends the cursor to its text box',
    placed[placed.length - 1] === note.id);

  // ---- placing a text box

  interactions.startDrawMode('text');
  pointer('pointerdown', 700, 250);
  pointer('pointerup', 700, 250);

  check('the text tool places a text box, not another note',
    annotations().length === 2 && state.annotationKind(newest()) === 'text');

  // ---- dragging an arrow out

  interactions.startDrawMode('arrow');
  pointer('pointerdown', 300, 300);

  check('an arrow is not committed on the way down', annotations().length === 2);

  pointer('pointermove', 460, 380);

  check('the preview follows the pointer',
    !!state.state.pendingArrow && state.state.pendingArrow.dx === 160 &&
    state.state.pendingArrow.dy === 80,
    JSON.stringify(state.state.pendingArrow));
  check('and is drawn, so the user can see what they are about to get',
    serialiseLayer('layer-overlay').includes('<line'));

  pointer('pointerup', 460, 380);

  const arrow = newest();

  check('releasing commits the arrow',
    annotations().length === 3 && state.annotationKind(arrow) === 'arrow');
  check('with the vector that was actually dragged',
    arrow.dx === 160 && arrow.dy === 80, arrow.dx + ',' + arrow.dy);
  check('the preview is cleared', !state.state.pendingArrow);
  check('and the tool disarms', !interactions.isDrawing());

  // ---- a click with no drag is not an arrow, and does not silently disarm

  interactions.startDrawMode('arrow');
  pointer('pointerdown', 800, 500);
  pointer('pointerup', 800, 500);

  check('a click with no drag makes no arrow', annotations().length === 3);
  check('and leaves the tool armed, because a click is the obvious thing to try first',
    interactions.isDrawing());

  // ---- every way out of a mode

  key('Escape');
  check('Escape cancels a draw tool', !interactions.isDrawing());

  interactions.startDrawMode('note');
  pointer('pointerdown', 400, 400, { button: 2 });
  pointer('pointerup', 400, 400, { button: 2 });
  check('a right-click cancels one too', !interactions.isDrawing());

  // The banner is appended to the body at the same z-index as the modal root and wins on DOM order,
  // so opening a dialog must end the mode - otherwise the banner asks for a click on a canvas the
  // user cannot reach, and Escape closes the dialog instead of the mode.
  interactions.startDrawMode('note');
  uiModule.openModal({ title: 'Anything', body: () => null });
  check('opening a dialog cancels a draw tool', !interactions.isDrawing());
  uiModule.closeModal();

  // ---- re-aiming an arrow by its handles

  state.selectOnly('annotations', arrow.id);
  render.render();

  const endHandle = withAttribute('data-arrow-end');
  const startHandle = withAttribute('data-arrow-start');

  check('a selected arrow exposes a handle at each end', !!endHandle && !!startHandle);

  const beforeReshape = { x: arrow.x, y: arrow.y, dx: arrow.dx, dy: arrow.dy };

  pointer('pointerdown', 100, 100, { target: endHandle });
  pointer('pointermove', 140, 100);
  pointer('pointerup', 140, 100);

  check('dragging the head re-aims the arrow',
    arrow.dx === beforeReshape.dx + 40 && arrow.dy === beforeReshape.dy,
    arrow.dx + ',' + arrow.dy);
  check('and leaves the tail exactly where it was',
    arrow.x === beforeReshape.x && arrow.y === beforeReshape.y);
  check('the reshape is one undoable step', state.canUndo());

  render.render();
  const tailHandle = withAttribute('data-arrow-start');
  const beforeTail = { x: arrow.x, dx: arrow.dx };

  pointer('pointerdown', 100, 100, { target: tailHandle });
  pointer('pointermove', 120, 100);
  pointer('pointerup', 120, 100);

  check('dragging the tail moves it and holds the head still',
    arrow.x === beforeTail.x + 20 && arrow.dx === beforeTail.dx - 20,
    arrow.x + ' / ' + arrow.dx);

  // ---- a marquee has to find an arrow drawn up and to the left

  state.clearSelection();
  state.state.doc.annotations = [arrow];

  arrow.x = 600; arrow.y = 600; arrow.dx = -120; arrow.dy = -80;
  render.render();

  const from = interactions.toScreen(470, 505);
  const to = interactions.toScreen(615, 615);

  pointer('pointerdown', from.x, from.y);
  pointer('pointermove', to.x, to.y);
  pointer('pointerup', to.x, to.y);

  check('a marquee over an arrow drawn up and to the left selects it',
    state.state.selection.annotations.has(arrow.id));

  key('Delete');
  check('and Delete takes it off the diagram', state.state.doc.annotations.length === 0);

  // ---- the resize grip on a sticky note

  const sticky = state.newAnnotation('note', { x: 100, y: 100 });
  state.mutate('note', () => { state.state.doc.annotations.push(sticky); });
  state.selectOnly('annotations', sticky.id);
  render.render();

  const grip = withAttribute('data-resize');
  check('a note has a grip that hit testing can actually reach', !!grip);

  pointer('pointerdown', 200, 200, { target: grip });
  pointer('pointermove', 264, 264);
  pointer('pointerup', 264, 264);

  // 140 to start, dragged 64 across and 64 down, snapped to the 8-unit grid the drag uses. The
  // *change* is snapped rather than the finished size: a note's default side is 140, which is not a
  // multiple of 8, so snapping the total would jump a new note to 144 at the first touch.
  check('dragging it resizes the note by the distance dragged',
    sticky.width === 204 && sticky.height === 204,
    sticky.width + 'x' + sticky.height);
  check('and moves in whole grid steps rather than landing between them',
    (sticky.width - 140) % 8 === 0 && (sticky.height - 140) % 8 === 0,
    sticky.width + 'x' + sticky.height);

  // ---- a new note is square, and stays that way only until it is resized

  check('a new sticky note is square at the default size',
    freshNote().width === 140 && freshNote().height === 140,
    JSON.stringify(freshNote()));
  check('and its text is 14px bold',
    freshNote().fontSize === 14 && freshNote().bold === true);

  function freshNote() {
    const note = state.newAnnotation('note', { x: 0, y: 0 });
    return { width: note.width, height: note.height, fontSize: note.fontSize, bold: note.bold };
  }

  // Free on each axis: a note stretched wide is a banner across the top of a diagram, which is a
  // reasonable thing to draw.
  sticky.width = 160; sticky.height = 160;
  render.render();

  const gripWide = withAttribute('data-resize');
  pointer('pointerdown', 300, 300, { target: gripWide });
  pointer('pointermove', 380, 300);
  pointer('pointerup', 380, 300);

  check('dragging the grip sideways widens the note and leaves its height alone',
    sticky.width === 240 && sticky.height === 160, sticky.width + 'x' + sticky.height);

  const gripTall = withAttribute('data-resize');
  pointer('pointerdown', 300, 300, { target: gripTall });
  pointer('pointermove', 300, 340);
  pointer('pointerup', 300, 340);

  check('and dragging it down makes it taller and no wider',
    sticky.width === 240 && sticky.height === 200, sticky.width + 'x' + sticky.height);

  // The grip has to stay under the pointer on each axis - that is what "resize" means.
  sticky.x = 100; sticky.y = 100; sticky.width = 160; sticky.height = 160;
  render.render();

  const gripTrack = withAttribute('data-resize');
  const grabbed = interactions.toScreen(sticky.x + sticky.width, sticky.y + sticky.height);

  pointer('pointerdown', grabbed.x, grabbed.y, { target: gripTrack });
  pointer('pointermove', grabbed.x + 64, grabbed.y + 32);
  pointer('pointerup', grabbed.x + 64, grabbed.y + 32);

  const corner = interactions.toScreen(sticky.x + sticky.width, sticky.y + sticky.height);

  // The note's own corner, which is where the arithmetic puts it. The drawn grip is inside the
  // sticky tilt and so sits a pixel or two off that corner; this check is about the maths, not
  // about the rotation.
  check('and after a drag the note\'s corner is under the pointer',
    Math.abs(corner.x - (grabbed.x + 64)) <= 1 && Math.abs(corner.y - (grabbed.y + 32)) <= 1,
    corner.x + ',' + corner.y + ' against ' + (grabbed.x + 64) + ',' + (grabbed.y + 32));

  // A brand-new note is 140 square, which is not on the 8-unit grid.
  sticky.width = 140; sticky.height = 140;
  render.render();

  // 303, not 302: onPointerMove ignores travel under 3px, so a 2px nudge would never reach the resize
  // arithmetic at all. hypot(3,3) is 4.24, which gets in; round(3/8)*8 is still 0, which is the
  // thing being pinned.
  const gripNudge = withAttribute('data-resize');
  pointer('pointerdown', 300, 300, { target: gripNudge });
  pointer('pointermove', 303, 303);
  pointer('pointerup', 303, 303);

  check('a nudge too small to be a grid step leaves a new note at its own size',
    sticky.width === 140 && sticky.height === 140, sticky.width + 'x' + sticky.height);

  // Shrinking, and the floor. A note below about 56 units tall is a coloured square with nothing
  // legible on it, and below 120 wide there is no line of text that fits.
  sticky.width = 200; sticky.height = 200;
  render.render();

  const gripFloor = withAttribute('data-resize');
  pointer('pointerdown', 300, 300, { target: gripFloor });
  pointer('pointermove', 60, 60);
  pointer('pointerup', 60, 60);

  check('shrinking a note stops at a size that can still hold something',
    sticky.width === 120 && sticky.height === 56, sticky.width + 'x' + sticky.height);

  // A text box resizes the same way.
  state.state.doc.annotations.length = 0;
  state.clearSelection();

  const label = state.newAnnotation('text', { x: 400, y: 400 });
  state.mutate('text', () => { state.state.doc.annotations.push(label); });
  state.selectOnly('annotations', label.id);
  render.render();

  const textGrip = withAttribute('data-resize');
  const labelHeight = label.height;

  pointer('pointerdown', 500, 500, { target: textGrip });
  pointer('pointermove', 580, 500);
  pointer('pointerup', 580, 500);

  check('a text box resizes on one axis too',
    label.width > 220 && label.height === labelHeight,
    label.width + 'x' + label.height);

  state.state.doc.annotations.length = 0;
  state.clearSelection();
  render.render();
}

// --------------------------------------------------- dialogs, for real ----
//
// Importing a dialog module proves its graph resolves. Opening one proves it builds. Driving its
// buttons proves the screen behind the button builds too - including the second screens of the
// explorer and the path finder.

console.log('\nThe dialogs build and their buttons lead somewhere');

{
  const uiModule = await import(js + 'ui.js');
  const bridge = await import(js + 'bridge.js');
  const proposedModule = await import(js + 'proposed.js');
  const dialogsModule = await import(js + 'dialogs.js');
  const explorerModule = await import(js + 'explorer.js');
  const sourcepickerModule = await import(js + 'sourcepicker.js');

  const modal = () => document.getElementById('modal-root');
  const modalText = () => new XMLSerializer().serializeToString(modal());

  const find = (root, predicate) => {
    for (const child of root.childNodes) {
      if (predicate(child)) return child;
      const deeper = find(child, predicate);
      if (deeper) return deeper;
    }
    return null;
  };

  const clickButton = label => {
    const node = find(modal(), n =>
      n.tagName === 'button' && String(n.textContent).trim() === label);

    if (!node) return false;
    for (const handler of (node.listeners.click || []).slice()) {
      handler({ preventDefault() {}, stopPropagation() {} });
    }
    return true;
  };

  const settle = async () => {
    for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));
  };

  const opens = (label, open) => {
    let thrown = null;
    try { open(); } catch (error) { thrown = error; }
    check(label, thrown === null, thrown && thrown.message);
  };

  // The bridge is a plain object of functions, so the host can be stood in for.
  const catalogue = [
    { logicalName: 'account', displayName: 'Account', schemaName: 'Account', isCustom: false },
    { logicalName: 'contact', displayName: 'Contact', schemaName: 'Contact', isCustom: false },
    { logicalName: 'opportunity', displayName: 'Opportunity', schemaName: 'Opportunity', isCustom: false },
    { logicalName: 'cs_widget', displayName: 'Widget', schemaName: 'cs_Widget', isCustom: true }
  ];

  const summary = name => {
    const entry = catalogue.find(t => t.logicalName === name) || catalogue[0];
    return Object.assign({ isActivity: false, isIntersect: false }, entry);
  };

  sourcepickerModule.invalidateCatalogue();
  state.state.connection = { connected: true, organizationFriendlyName: 'Verify', host: 'verify' };

  bridge.host.listTables = async () => catalogue;
  bridge.host.exploreGraph = async () => ({
    message: '',
    filteredOut: 3,
    tables: [
      { summary: summary('account'), hops: 0, degree: 3, via: [] },
      { summary: summary('contact'), hops: 1, degree: 2, via: ['contact_customer_accounts'] },
      { summary: summary('cs_widget'), hops: 2, degree: 1, via: ['cs_widget_account'] }
    ]
  });
  bridge.host.findPaths = async () => ({
    message: '',
    paths: [
      // First in the list, and not drawable: it has to end up last.
      { steps: [{ table: 'account' }, { table: 'nowhere', relationshipSchemaName: 'a_nowhere' },
                { table: 'contact', relationshipSchemaName: 'nowhere_contact' }] },
      { steps: [{ table: 'account' }, { table: 'contact', relationshipSchemaName: 'contact_customer_accounts' }] }
    ]
  });

  // ---- the propose hub and the editors under it

  opens('the propose hub builds', () => proposedModule.openProposeHub({ x: 0, y: 0 }));
  check('and offers all four kinds of change',
    /A new table/.test(modalText()) && /A relationship/.test(modalText()) &&
    /An external system/.test(modalText()));
  uiModule.closeModal();

  const someTable = state.state.doc.tables[0];

  opens('the column editor builds', () => proposedModule.openProposedColumnEditor(someTable.id));
  check('and says where lookups have gone rather than just not offering them',
    /Looking for a lookup/.test(modalText()));
  check('with a way through to the editor that does make them',
    /Propose a relationship instead/.test(modalText()));
  uiModule.closeModal();

  opens('the relationship editor builds', () => proposedModule.openProposedRelationshipEditor());
  check('and names the lookup column it is going to create',
    /proposed lookup column/.test(modalText()), modalText().slice(0, 120));
  uiModule.closeModal();

  // ---- display settings, diagram properties, layout, the guide

  opens('display settings builds', () => dialogsModule.openDisplaySettings());
  uiModule.closeModal();

  opens('diagram properties builds', () => dialogsModule.openDiagramProperties());
  uiModule.closeModal();

  opens('the layout menu builds', () => dialogsModule.openLayoutMenu(document.getElementById('canvas')));
  uiModule.closeModal();

  opens('the feature guide builds',
    () => dialogsModule.openFeatureGuide({ toolName: 'Oliver4 Data Model Designer', version: '1.6.0' }));
  check('and carries the brand above the tool name', /OLIVER4/.test(modalText()));
  check('and the build it is describing', /1\.6\.0/.test(modalText()));
  check('and draws the 256px artwork rather than the 128px file',
    /logo-256\.png|logo-dark-256\.png/.test(modalText()));
  uiModule.closeModal();

  // ---- the path finder, driven through its Search button

  await dialogsModule.openPathFinder();
  await settle();

  check('the path finder builds', /How are these two tables connected/.test(modalText()));

  check('pressing Search is possible', clickButton('Search'));
  await settle();

  const results = modalText();

  check('a path already on the diagram is flagged', /ON CANVAS/.test(results));
  check('and the row says clicking it will do something',
    /Click to highlight this path on the canvas/.test(results));
  check('a path that is not says which tables are missing',
    /nowhere missing/.test(results), results.slice(-400));
  check('and the drawable one is listed first',
    results.indexOf('ON CANVAS') < results.indexOf('Not fully on the canvas'));

  uiModule.closeModal();

  // ---- the explorer, through both of its screens

  explorerModule.openExplorer();
  await settle();

  const setup = modalText();

  check('the explorer opens on its settings', /What is this table connected to/.test(setup));
  check('with the filters it is going to walk with', /Hide platform plumbing/.test(setup));
  check('and Explore in the footer, where it cannot be scrolled away from',
    find(document.getElementById('modal-root'), n =>
      n.tagName === 'button' && String(n.textContent).trim() === 'Explore' &&
      n.closest('.modal-foot')) !== null);

  check('pressing Explore is possible', clickButton('Explore'));
  await settle();

  const walked = modalText();

  check('the results replace the settings rather than sharing the dialog with them',
    !/Hide platform plumbing/.test(walked) && /Hop 1/.test(walked));
  check('the starting table is its own group', /Starting table/.test(walked));
  check('a table already on the diagram is flagged with the same badge the path finder uses',
    /ON CANVAS/.test(walked));
  check('the filtered-out count reads as a sentence rather than "3 table were left out"',
    /3 tables were left out/.test(walked), /left out[^<]*/.exec(walked));
  check('and points at the settings screen rather than at a left-hand panel that is not there',
    /Change settings/.test(walked) && !/on the left/.test(walked));

  check('there is a way back to the settings', clickButton('◀  Change settings'));
  await settle();

  check('which returns to them with the walk still in hand',
    /Hide platform plumbing/.test(modalText()) && /Back to results/.test(modalText()));

  uiModule.closeModal();

  // ---- the inspector, for each kind of drawn thing

  const inspectorModule = await import(js + 'inspector.js');
  const panelsModule = await import(js + 'panels.js');

  const kinds = [
    ['note', 'Sticky note', 'Paper'],
    ['text', 'Text box', 'Text colour'],
    ['arrow', 'Arrow', 'Colour']
  ];

  for (const [kind, title, section] of kinds) {
    const annotation = state.newAnnotation(kind, { x: 10, y: 10 }, { dx: 90, dy: 30 });
    state.state.doc.annotations = [annotation];
    state.selectOnly('annotations', annotation.id);

    let thrown = null;
    try { inspectorModule.refreshInspector(); } catch (error) { thrown = error; }

    const body = new XMLSerializer().serializeToString(document.getElementById('inspector-body'));

    check('the inspector builds for a ' + title.toLowerCase(), thrown === null, thrown && thrown.message);
    check('and is titled "' + title + '" rather than "Note"',
      document.getElementById('inspector-title').textContent === title,
      document.getElementById('inspector-title').textContent);
    check('and offers the ' + section.toLowerCase() + ' control that kind actually has',
      body.includes(section), body.slice(0, 160));
  }

  // An arrow has no text, so it must not be listed by its first line as "(empty note)".
  state.state.doc.annotations = [
    state.newAnnotation('arrow', { x: 0, y: 0 }, { dx: 60, dy: 0 }),
    state.newAnnotation('text', { x: 0, y: 0 })
  ];

  let panelThrown = null;
  try { panelsModule.showTab('notes'); } catch (error) { panelThrown = error; }

  const notesTab = new XMLSerializer().serializeToString(document.getElementById('tab-notes'));

  check('the notes panel builds with every kind on it', panelThrown === null, panelThrown && panelThrown.message);
  check('and calls an arrow an arrow', notesTab.includes('Arrow'), notesTab.slice(0, 300));
  check('and an empty text box a text box', notesTab.includes('(empty text box)'), notesTab.slice(0, 300));
  check('and offers to add a sticky note rather than "a note"',
    notesTab.includes('+ Add sticky note'));

  // Both other tabs are built too.
  let tabThrown = null;
  try {
    panelsModule.showTab('relationships');
    panelsModule.showTab('model');
  } catch (error) { tabThrown = error; }

  check('the model and relationship tabs build too', tabThrown === null, tabThrown && tabThrown.message);

  state.state.doc.annotations.length = 0;
  state.clearSelection();
  inspectorModule.hideInspector();
  sourcepickerModule.invalidateCatalogue();
  state.state.connection = { connected: false };
  render.render();
}

console.log('\nAn arriving document reconciles its relationship-owned lookups');

// A whole document arrives by three routes - opened from disk, refreshed against Dataverse, pushed
// by the host - and none of them goes through the editors that keep a relationship and the lookup
// column it owns in step. Two states are repaired on the way in, because otherwise the column
// could neither be edited (the column editor forwards to the relationship editor, which refuses a
// relationship that is not proposed) nor removed.
{
  const doc = state.newDocument('Arriving document');

  doc.tables.push({
    id: 't-one', logicalName: 'account', schemaName: 'Account', displayName: 'Account',
    status: 'Existing', x: 0, y: 0, columns: [], alternateKeys: []
  });

  doc.tables.push({
    id: 't-many', logicalName: 'contact', schemaName: 'Contact', displayName: 'Contact',
    status: 'Existing', x: 400, y: 0, alternateKeys: [],
    columns: [
      // Owned by a relationship the host has since promoted to Existing.
      { id: 'c-promoted', logicalName: 'cs_promotedid', displayName: 'Promoted', typeName: 'Lookup',
        isLookup: true, targets: ['account'], selected: true, status: 'Proposed',
        fromRelationshipId: 'r-promoted' },
      // Owned by a relationship that is not in the document at all.
      { id: 'c-orphan', logicalName: 'cs_orphanid', displayName: 'Orphan', typeName: 'Lookup',
        isLookup: true, targets: ['account'], selected: true, status: 'Proposed',
        fromRelationshipId: 'r-gone' }
    ]
  });

  doc.relationships.push({
    id: 'r-promoted', schemaName: 'cs_promoted', kind: 'OneToMany', status: 'Existing',
    fromTableId: 't-one', toTableId: 't-many', referencingAttribute: 'cs_promotedid',
    included: true, hidden: false, waypoints: [], lookupTargets: []
  });

  state.setDocument(doc, null);
  geometry.invalidateSizes();

  const promoted = state.state.doc.tables[1].columns.find(c => c.id === 'c-promoted');
  const orphan = state.state.doc.tables[1].columns.find(c => c.id === 'c-orphan');

  check('a column whose relationship has been promoted stops being drawn as a proposal',
    promoted.status === 'Existing', promoted.status);
  check('and keeps its link, so proposing the relationship again takes it back',
    promoted.fromRelationshipId === 'r-promoted');
  check('a column whose relationship has gone is nobody\'s and can be edited again',
    !orphan.fromRelationshipId);
  check('and is left exactly as proposed, because nothing said otherwise', orphan.status === 'Proposed');
}

console.log('\nAdding tables again does not duplicate what a proposal already claims');

// The lookup name a proposed relationship derives is the name Dataverse would use - `accountid`
// really is the name on both sides - so a proposal and the real column collide as a matter of
// course rather than by coincidence. Two rows with one logical name is a card that reads as a bug,
// and rowCentreY anchors the connector to whichever of them comes first.
{
  const doc = state.newDocument('Re-add');
  state.setDocument(doc, null);

  const dto = (logicalName, displayName, extra) => ({
    logicalName, schemaName: displayName, displayName,
    primaryIdAttribute: logicalName + 'id', primaryNameAttribute: 'name',
    alternateKeys: [],
    columns: [
      { id: logicalName + 'pk', logicalName: logicalName + 'id', displayName: 'Identifier',
        typeName: 'Unique identifier', isPrimaryId: true, selected: true, status: 'Existing', targets: [] },
      ...(extra || [])
    ]
  });

  state.mutate('seed', () => {
    state.addTablesFromMetadata([dto('account', 'Account'), dto('contact', 'Contact')]);
  });

  const one = state.state.doc.tables.find(t => t.logicalName === 'account');
  const many = state.state.doc.tables.find(t => t.logicalName === 'contact');

  const proposal = {
    id: 'r-readd', schemaName: 'my_own_name_for_it', kind: 'OneToMany', status: 'Proposed',
    fromTableId: one.id, toTableId: many.id, referencingAttribute: '',
    included: true, hidden: false, highlight: null, waypoints: [], notes: ''
  };

  state.mutate('propose', () => {
    state.state.doc.relationships.push(proposal);
    state.syncProposedLookupColumn(proposal);
  });

  check('the proposal derives the name Dataverse would use',
    proposal.referencingAttribute === 'accountid', proposal.referencingAttribute);

  // Now Contact is added again, and this time the environment really does have accountid.
  const real = { id: 'realfk', logicalName: 'accountid', displayName: 'Account', typeName: 'Lookup',
    isLookup: true, selected: true, status: 'Existing', targets: ['account'] };

  state.mutate('add tables again', () => {
    state.addTablesFromMetadata([dto('contact', 'Contact', [real])]);
  });

  const named = (many.columns || []).filter(c =>
    String(c.logicalName || '').toLowerCase() === 'accountid');

  check('re-adding the table does not put the same logical name on the card twice',
    named.length === 1, named.length + ': ' + named.map(c => c.status).join(','));
  check('and the proposal is what stands, because nothing proposed is promoted without confirmation',
    named.length === 1 && named[0].status === 'Proposed' &&
    named[0].fromRelationshipId === proposal.id);

  // A real relationship describing the proposal must not be drawn beside it. Matched on the ends,
  // the cardinality and the lookup rather than the schema name, because a proposal's schema name is
  // whatever the user typed.
  const before = state.state.doc.relationships.length;

  state.mutate('discover relationships', () => {
    state.addRelationshipsFromMetadata([{
      schemaName: 'contact_customer_accounts', displayName: 'contact_customer_accounts',
      kind: 'OneToMany', referencedEntity: 'account', referencingEntity: 'contact',
      referencedAttribute: 'accountid', referencingAttribute: 'accountid', lookupTargets: []
    }]);
  });

  check('a real relationship that describes a standing proposal is not drawn beside it',
    state.state.doc.relationships.length === before,
    state.state.doc.relationships.length + ' relationships');

  // One that is genuinely different still arrives.
  state.mutate('discover another', () => {
    state.addRelationshipsFromMetadata([{
      schemaName: 'contact_secondary_account', displayName: 'contact_secondary_account',
      kind: 'OneToMany', referencedEntity: 'account', referencingEntity: 'contact',
      referencedAttribute: 'accountid', referencingAttribute: 'cs_secondaryaccountid', lookupTargets: []
    }]);
  });

  check('a different relationship between the same two tables is still added',
    state.state.doc.relationships.length === before + 1);
}

console.log('\nThe card controls leave a relationship\'s lookup alone');

{
  const inspectorModule = await import(js + 'inspector.js');

  const table = state.state.doc.tables.find(t => t.logicalName === 'contact');
  const owned = (table.columns || []).find(c => c.fromRelationshipId);

  check('the fixture still has a relationship-owned lookup on it', !!owned);

  state.state.doc.settings.fieldDetail = 'AllFields';
  geometry.invalidateSizes();
  state.selectOnly('tables', table.id);
  inspectorModule.refreshInspector();

  const body = document.getElementById('inspector-body');

  const findWithListener = (root, predicate) => {
    for (const child of root.childNodes) {
      if (predicate(child)) return child;
      const deeper = findWithListener(child, predicate);
      if (deeper) return deeper;
    }
    return null;
  };

  // The tick row for that column: a .toggle carrying a click handler whose text names it.
  const row = findWithListener(body, node =>
    node.classList && node.classList.contains('toggle') &&
    (node.listeners.click || []).length &&
    String(node.textContent).includes(owned.displayName || owned.logicalName));

  check('the column has a tick row in the inspector', !!row);

  for (const handler of ((row && row.listeners.click) || []).slice()) {
    handler({ preventDefault() {}, stopPropagation() {} });
  }

  // Unticking must be refused: it would remove the row the connector anchors to and drop the column
  // from every export while the connector still says the lookup is being added, and the sync would
  // tick it again the next time anything touched the relationship.
  check('unticking a relationship-owned lookup is refused rather than silently undone later',
    owned.selected !== false);
  check('so it is still drawn on the card',
    geometry.visibleColumns(table).some(c => c.id === owned.id));

  // "None" must honour the same guard, and say so, rather than taking the owned lookup off the card.
  const ordinary = (table.columns || []).find(c => !c.fromRelationshipId && !c.isPrimaryId);
  const noneButton = findWithListener(body, node =>
    node.tagName === 'button' && String(node.textContent).trim() === 'None');

  check('the columns heading offers None', !!noneButton);

  for (const handler of ((noneButton && noneButton.listeners.click) || []).slice()) {
    handler({ preventDefault() {}, stopPropagation() {} });
  }

  check('None takes the ordinary columns off the card', !ordinary || ordinary.selected === false);
  check('and leaves the relationship-owned lookup alone', owned.selected !== false);
  check('so the connector still has its row to anchor to',
    geometry.visibleColumns(table).some(c => c.id === owned.id));

  state.mutate('put them back', () => { (table.columns || []).forEach(c => { c.selected = true; }); });
  geometry.invalidateSizes();
  inspectorModule.refreshInspector();

  // The clock control. A lookup and its relationship are one object in Dataverse, so a column struck
  // through beside a connector drawn as live would say two contradictory things.
  const ownedRow = findWithListener(document.getElementById('inspector-body'), node =>
    node.classList && node.classList.contains('column-row') &&
    String(node.textContent).includes(owned.displayName || owned.logicalName));

  const clock = ownedRow && findWithListener(ownedRow, node =>
    node.tagName === 'button' && node.classList && node.classList.contains('icon-btn') &&
    (node.listeners.click || []).length);

  check('the owned lookup has a deprecate control like any other column', !!clock);

  const toastRoot = document.getElementById('toast-root');
  while (toastRoot.childNodes.length) toastRoot.removeChild(toastRoot.childNodes[0]);

  for (const handler of ((clock && clock.listeners.click) || []).slice()) {
    handler({ preventDefault() {}, stopPropagation() {} });
  }

  check('marking a relationship-owned lookup deprecated is refused',
    owned.status !== 'Deprecated', String(owned.status));

  // Refused, and refused for the right reason. The generic guard advises marking the relationship
  // deprecated, which only applies to an existing relationship; a *proposed* one has no deprecated
  // state, and the proposed-column message points at a delete control the list does not offer for a
  // lookup a relationship owns. Naming the relationship is the only answer that leads anywhere.
  const refusal = String(toastRoot.textContent || '');
  const ownerOfIt = state.relationshipById(owned.fromRelationshipId);

  check('and the message names the relationship it belongs to',
    !!ownerOfIt && refusal.includes(ownerOfIt.schemaName), refusal);

  state.state.doc.settings.fieldDetail = 'RelationshipFields';
  geometry.invalidateSizes();
  state.clearSelection();
  inspectorModule.hideInspector();
}

// ------------------------------------------- export and refresh dialogs ----
//
// Two dialogs that speak for the whole diagram: one says what a format cannot carry, the other
// says what a refresh will leave alone. Both must account for arrows and text boxes.

console.log('\nThe export and refresh dialogs tell the truth about what is on the canvas');

{
  const uiModule = await import(js + 'ui.js');
  const bridge = await import(js + 'bridge.js');
  const exporterModule = await import(js + 'exporter.js');
  const refreshModule = await import(js + 'refresh.js');

  const modal = () => document.getElementById('modal-root');
  const modalText = () => new XMLSerializer().serializeToString(modal());
  const modalOpen = () => modal().childNodes.length > 0;

  const find = (root, predicate) => {
    for (const child of root.childNodes) {
      if (predicate(child)) return child;
      const deeper = find(child, predicate);
      if (deeper) return deeper;
    }
    return null;
  };

  const clickText = label => {
    const node = find(modal(), n =>
      n.tagName === 'button' && String(n.textContent).includes(label) &&
      (n.listeners.click || []).length);

    if (!node) return false;
    for (const handler of node.listeners.click.slice()) {
      handler({ preventDefault() {}, stopPropagation() {} });
    }
    return true;
  };

  const settle = async () => {
    for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0));
  };

  // ---- a canvas of drawings with no table is still a diagram

  const kept = state.state.doc;
  state.setDocument(state.newDocument('Sketch'), null);

  uiModule.closeModal();
  exporterModule.openExportDialog();

  check('an empty canvas has nothing to export', !modalOpen());

  state.mutate('sketch', () => {
    state.state.doc.annotations.push(
      state.newAnnotation('arrow', { x: 100, y: 100 }),
      state.newAnnotation('arrow', { x: 200, y: 200 }));
  });

  exporterModule.openExportDialog();

  // Save treats a canvas of text boxes and arrows as a diagram, and it is - a sketch of a future
  // state before any table has been added - so export must not call it empty.
  check('a canvas of drawings alone can still be exported', modalOpen());

  check('Visio is offered', clickText('Visio'));

  const visio = modalText();

  // The wording distinguishes arrows from notes, so a canvas of arrows is not told "sticky notes and
  // text boxes themselves are exported" beside a line saying its arrows are dropped.
  check('and is honest that a drawn arrow will not survive it', /arrow/i.test(visio));
  check('without claiming there are notes it is keeping when there are none',
    !/Note leader lines/.test(visio));

  uiModule.closeModal();

  // And the other way round: once there is something a Visio export really does keep, it says so.
  state.mutate('add a note', () => {
    state.state.doc.annotations.push(state.newAnnotation('note', { x: 300, y: 300 }));
  });

  exporterModule.openExportDialog();
  clickText('Visio');

  check('a canvas that does have notes is told they are kept',
    /Note leader lines/.test(modalText()));

  uiModule.closeModal();

  // ---- the refresh review

  state.setDocument(kept, null);
  state.state.connection = {
    connected: true, organizationFriendlyName: 'Verify', host: 'verify', organizationId: null
  };

  state.mutate('draw on it', () => {
    state.state.doc.annotations.push(state.newAnnotation('arrow', { x: 40, y: 40 }));
  });

  bridge.host.refreshDiagram = async document => ({
    document,
    report: {
      found: [], changed: [], missing: [],
      promotionCandidates: [{
        diagramObjectId: 'x1',
        parentTableId: state.state.doc.tables[0].id,
        objectKind: 'column',
        proposedName: 'Account',
        matchedLogicalName: 'accountid',
        matchedDisplayName: 'Account',
        confidence: 'low',
        matchReason: 'Display name matches'
      }]
    }
  });

  await refreshModule.runRefresh();
  await settle();

  const review = modalText();

  check('the refresh review opens', modalOpen() && /Refresh review/.test(review));

  // The sentence naming what survives a refresh covers notes, text boxes and arrows.
  check('it says drawn sticky notes, text boxes and arrows are preserved',
    /sticky/i.test(review) && /text box/i.test(review) && /arrow/i.test(review));

  // Every group in the dialog says what it is talking about, so a promotion row names its kind -
  // table or connector's lookup column - before it is ticked.
  check('and a promotion row says what kind of object it is offering to promote',
    /column/.test(review));

  uiModule.closeModal();
  state.state.connection = null;
}

// ------------------------------------------------ source and dialog pins ----
//
// Pinned where the behaviour lives: behaviourally for the modules this suite can import, and as
// source checks for app.js, which it cannot - see "Boot-order safety in app.js" below for why. The
// dialog pins drive the real dialogs: stub the host on the bridge, open the dialog, walk
// #modal-root for the control, fire its listeners.

{
  const uiModule = await import(js + 'ui.js');
  const bridge = await import(js + 'bridge.js');
  const inspectorModule = await import(js + 'inspector.js');
  const proposedModule = await import(js + 'proposed.js');
  const dialogsModule = await import(js + 'dialogs.js');
  const explorerModule = await import(js + 'explorer.js');
  const sourcepickerModule = await import(js + 'sourcepicker.js');
  const interactions = await import(js + 'interact.js');
  const panelsModule = await import(js + 'panels.js');
  const fsModule = await import('node:fs');

  // ---- shared plumbing

  const find = (root, predicate) => {
    for (const child of root.childNodes) {
      if (predicate(child)) return child;
      const deeper = find(child, predicate);
      if (deeper) return deeper;
    }
    return null;
  };

  const findAll = (root, predicate, found) => {
    const list = found || [];
    for (const child of root.childNodes) {
      if (predicate(child)) list.push(child);
      findAll(child, predicate, list);
    }
    return list;
  };

  const modal = () => document.getElementById('modal-root');
  const modalText = () => new XMLSerializer().serializeToString(modal());
  const modalOpen = () => modal().childNodes.length > 0;

  const fire = (node, type, event) => {
    const handlers = ((node && node.listeners && node.listeners[type]) || []).slice();
    for (const handler of handlers) {
      handler(Object.assign({ type, target: node, preventDefault() {}, stopPropagation() {} }, event || {}));
    }
    return handlers.length > 0;
  };

  const clickNode = node => fire(node, 'click');

  const clickByText = (root, text) => {
    const node = find(root, n => n.tagName === 'button' && String(n.textContent).includes(text) &&
      (n.listeners.click || []).length);
    return node ? clickNode(node) : false;
  };

  /** Any clickable node - the explorer's result rows and the wizard's solution rows are divs. */
  const clickRow = (root, text) => {
    const node = find(root, n => (n.listeners.click || []).length &&
      String(n.textContent).includes(text));
    return node ? clickNode(node) : false;
  };

  const settle = async () => {
    for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0));
  };

  const after = ms => new Promise(resolve => setTimeout(resolve, ms));

  /** The control inside a field() wrapper carrying a given label. */
  const fieldControl = (root, label, tagName) => {
    const wrapper = find(root, node =>
      node.classList && node.classList.contains('field') &&
      find(node, span => span.tagName === 'span' && String(span.textContent).trim() === label));

    return wrapper ? find(wrapper, node => node.tagName === tagName) : null;
  };

  const type = (control, text) => {
    for (let i = 1; i <= text.length; i++) {
      control.value = text.slice(0, i);
      fire(control, 'input');
    }
  };

  const commitField = control => fire(control, 'change');

  const pickOption = (control, value) => { control.value = value; fire(control, 'change'); };

  const inspectorBody = () => document.getElementById('inspector-body');

  // WCAG 2.1 relative luminance and contrast, so a ratio quoted in a comment beside a colour can be
  // checked rather than believed.
  const luminance = hex => {
    const value = String(hex || '').replace('#', '').trim();
    const channels = [0, 2, 4]
      .map(i => parseInt(value.slice(i, i + 2), 16) / 255)
      .map(c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };

  const contrast = (a, b) => {
    const first = luminance(a);
    const second = luminance(b);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  };

  /** A plain table for a fixture document, with whatever extra columns are wanted. */
  const fixtureTable = (id, logicalName, displayName, extraColumns) => ({
    id, logicalName, schemaName: displayName.replace(/\s/g, ''), displayName,
    status: 'Existing', x: 0, y: 0, collapsed: false, detailOverride: null,
    highlight: null, notes: '', alternateKeys: [], primaryIdAttribute: logicalName + 'id',
    primaryNameAttribute: 'name',
    columns: [
      { id: id + 'pk', logicalName: logicalName + 'id', schemaName: logicalName + 'Id',
        displayName: 'Identifier', typeName: 'Unique identifier', isPrimaryId: true,
        isPrimaryName: false, isLookup: false, targets: [], selected: true, status: 'Existing' },
      ...(extraColumns || [])
    ]
  });

  // Every pin below starts from a document it built itself. Sharing one would make the order of the
  // sections part of what is being tested.
  const freshDocument = title => {
    state.setDocument(state.newDocument(title), null);
    geometry.invalidateSizes();
    return state.state.doc;
  };

  uiModule.closeModal();
  state.clearSelection();
  inspectorModule.hideInspector();

  // =====================================================================
  console.log('\nThe inspector\'s inline relationship editor keeps the lookup column in step');
  // =====================================================================
  //
  // The inspector's inline relationship editor - the one the user reaches by clicking a proposed
  // connector - must end every change with syncProposedLookupColumn, as the modal editor in
  // proposed.js does. Otherwise the lookup column it owns is not renamed, not moved when the many
  // end changes, and not removed when the relationship becomes an N:N - and, still owned by a
  // living relationship, it is refused by every removal route the UI offers.
  //
  // Driven through the real editor rather than by calling syncProposedLookupColumn directly, because
  // the editor's wiring is what is under test.
  {
    const doc = freshDocument('Inline relationship editor');

    const one = fixtureTable('t-one', 'account', 'Account');
    const many = fixtureTable('t-many', 'contact', 'Contact');
    const otherMany = fixtureTable('t-other', 'opportunity', 'Opportunity');

    doc.tables.push(one, many, otherMany);

    const link = {
      id: 'r-inline', schemaName: 'cs_inline', kind: 'OneToMany', status: 'Proposed',
      fromTableId: one.id, toTableId: many.id, referencingAttribute: '',
      included: true, hidden: false, highlight: null, waypoints: [], notes: ''
    };

    state.mutate('propose', () => {
      doc.relationships.push(link);
      state.syncProposedLookupColumn(link);
    });

    state.state.doc.settings.fieldDetail = 'AllFields';
    geometry.invalidateSizes();

    const ownedOn = table => (table.columns || []).filter(c => c.fromRelationshipId === link.id);

    check('the proposal starts with its lookup column on the many end',
      ownedOn(many).length === 1 && ownedOn(many)[0].logicalName === 'accountid',
      ownedOn(many).map(c => c.logicalName).join(','));

    state.selectOnly('relationships', link.id);
    inspectorModule.refreshInspector();

    check('clicking a proposed connector opens the inline editor',
      !!fieldControl(inspectorBody(), 'Lookup column', 'input'));

    // ---- renaming the lookup

    const beforeRename = geometry.measureTable(many).rows.map(r => r.column.logicalName).join(',');

    const lookupBox = fieldControl(inspectorBody(), 'Lookup column', 'input');
    type(lookupBox, 'cs_owningaccountid');
    commitField(lookupBox);

    check('renaming the lookup in the inspector renames the column it owns',
      ownedOn(many).length === 1 && ownedOn(many)[0].logicalName === 'cs_owningaccountid',
      ownedOn(many).map(c => c.logicalName).join(','));

    // The card is a different card now, and nothing but the editor knows that. The editor must call
    // invalidateSizes, or the measured rows are the ones taken before the rename and the connector
    // anchors to a row under its old name.
    const afterRename = geometry.measureTable(many).rows.map(r => r.column.logicalName).join(',');

    check('and the card is re-measured rather than left on the rows it had before',
      afterRename !== beforeRename && afterRename.includes('cs_owningaccountid'), afterRename);

    // ---- moving the many end

    inspectorModule.refreshInspector();
    const manySelect = fieldControl(inspectorBody(), 'Related table (many)', 'select');

    check('the inline editor offers the many end as a picker', !!manySelect);

    pickOption(manySelect, otherMany.id);

    check('changing the many end moves the lookup column to the new card',
      ownedOn(otherMany).length === 1, ownedOn(otherMany).map(c => c.logicalName).join(','));
    check('and leaves none behind on the old one',
      ownedOn(many).length === 0, ownedOn(many).map(c => c.logicalName).join(','));

    // ---- switching to N:N

    inspectorModule.refreshInspector();
    const kindSelect = fieldControl(inspectorBody(), 'Relationship type', 'select');

    check('the inline editor offers the cardinality', !!kindSelect);

    pickOption(kindSelect, 'ManyToMany');

    check('an N:N has no lookup, so switching to one takes the column off every card',
      !state.state.doc.tables.some(t => (t.columns || []).some(c => c.fromRelationshipId === link.id)),
      state.state.doc.tables
        .map(t => t.logicalName + ':' + (t.columns || []).filter(c => c.fromRelationshipId === link.id).length)
        .join(' '));

    state.clearSelection();
    inspectorModule.hideInspector();
  }

  // =====================================================================
  console.log('\nThe size cache answers for the relationships that are actually visible');
  // =====================================================================
  //
  // The size cache key must identify *which* relationships are visible, not how many: two different
  // sets of the same size share a count. Hide r1, hide r2, show r1 - the first and last states both
  // have one visible relationship, and a count key would draw r2's lookup row with r1's connector
  // anchored to the header. Driven through mutate() and render(), which is exactly what the tick in
  // the relationships panel does.
  {
    const doc = freshDocument('Two lookups, one card');

    const oneA = fixtureTable('t-a', 'account', 'Account');
    const oneB = fixtureTable('t-b', 'opportunity', 'Opportunity');
    const many = fixtureTable('t-many', 'contact', 'Contact', [
      { id: 'c-r1', logicalName: 'cs_r1fk', schemaName: 'cs_R1fk', displayName: 'From A',
        typeName: 'Lookup', isLookup: true, isPrimaryId: false, isPrimaryName: false,
        targets: ['account'], selected: true, status: 'Existing' },
      { id: 'c-r2', logicalName: 'cs_r2fk', schemaName: 'cs_R2fk', displayName: 'From B',
        typeName: 'Lookup', isLookup: true, isPrimaryId: false, isPrimaryName: false,
        targets: ['opportunity'], selected: true, status: 'Existing' }
    ]);

    oneA.x = 0; oneA.y = 0;
    oneB.x = 0; oneB.y = 400;
    many.x = 700; many.y = 0;

    doc.tables.push(oneA, oneB, many);

    const r1 = {
      id: 'r-1', schemaName: 'cs_r1', kind: 'OneToMany', status: 'Existing',
      fromTableId: oneA.id, toTableId: many.id,
      referencedAttribute: 'accountid', referencingAttribute: 'cs_r1fk',
      included: true, hidden: false, waypoints: [], lookupTargets: []
    };
    const r2 = {
      id: 'r-2', schemaName: 'cs_r2', kind: 'OneToMany', status: 'Existing',
      fromTableId: oneB.id, toTableId: many.id,
      referencedAttribute: 'opportunityid', referencingAttribute: 'cs_r2fk',
      included: true, hidden: false, waypoints: [], lookupTargets: []
    };

    doc.relationships.push(r1, r2);

    // "Relationship fields" is the default and the only mode where this can bite: it is what makes
    // the rows drawn depend on which connectors are visible.
    state.state.doc.settings.fieldDetail = 'RelationshipFields';
    geometry.invalidateSizes();

    const rowsOnCard = () => geometry.measureTable(many).rows.map(r => r.column.logicalName);

    check('both lookups are drawn while both connectors are',
      rowsOnCard().includes('cs_r1fk') && rowsOnCard().includes('cs_r2fk'), rowsOnCard().join(','));

    // The exact sequence, through the mutate/render path the relationships panel's tick uses.
    const toggle = (relationship, included) => {
      state.mutate('toggle relationship', () => {
        relationship.included = included;
        relationship.hidden = false;
      });
      render.render();
    };

    toggle(r1, false);
    check('hiding the first leaves only the second\'s lookup',
      !rowsOnCard().includes('cs_r1fk') && rowsOnCard().includes('cs_r2fk'), rowsOnCard().join(','));

    toggle(r2, false);
    toggle(r1, true);

    // One visible relationship again - the same count as two steps ago, but a different set.
    const rows = rowsOnCard();

    check('showing the first again draws its lookup and not the one that is now hidden',
      rows.includes('cs_r1fk') && !rows.includes('cs_r2fk'), rows.join(','));

    // The visible consequence: a connector that cannot find its row falls back to the middle of the
    // card header.
    const rect = geometry.tableRect(many);
    const rowIndex = rect.rows.findIndex(row => row.column.logicalName === 'cs_r1fk');
    const route = geometry.routeRelationship(r1, 0, 1);
    const rowCentre = rect.y + geometry.METRICS.headerHeight +
                      rowIndex * geometry.METRICS.rowHeight + geometry.METRICS.rowHeight / 2;

    check('so the connector still lands on its lookup row rather than the card header',
      rowIndex >= 0 && route && Math.abs(route.end.y - rowCentre) < 0.5,
      route && route.end.y + ' vs ' + rowCentre);
  }

  // =====================================================================
  console.log('\nThe size-cache key costs nothing to build');
  // =====================================================================
  //
  // Building the size cache key must be cheap. measureTable is reached once per card plus once per
  // end of every connector, so calling visibleRelationships() (which walks every relationship in the
  // document) inside it would cost far more than the measurement the cache exists to avoid.
  {
    const geometrySource = fsModule.readFileSync(
      '../../src/Oliver4.DataModelDesigner/Web/js/geometry.js', 'utf8');

    // measureTable only. visibleRelationships is legitimately used elsewhere in this module - by
    // visibleColumns, which is the measurement, and by documentBounds - so the whole file would say
    // nothing.
    const start = geometrySource.indexOf('export function measureTable(');
    const end = geometrySource.indexOf('\nfunction alternateKeyKey(', start);
    // Comments stripped first, so a comment naming the call cannot satisfy the check.
    const body = geometrySource.slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    check('the measure body is where this suite thinks it is', start >= 0 && end > start,
      start + '..' + end);
    check('building the cache key no longer walks the relationships',
      !/visibleRelationships\s*\(/.test(body),
      (/.*visibleRelationships.*/.exec(body) || [''])[0].trim());
    check('it reads the topology counter instead',
      /topologyVersion\s*\(\s*\)/.test(body));

    // A wall-clock budget, on the size of model this tool is used on. Deliberately loose: this runs
    // on whatever hardware the build agent gives it, under a DOM shim rather than a browser, and a
    // flaky timing check gets disabled rather than investigated. This frame takes about 15ms, so
    // 250ms is roughly fifteen times the headroom.
    //
    // This budget cannot catch a count-of-visible-relationships key (the static check above pins
    // that): the costs stay within about a factor of two of each other as the document grows. It is a
    // floor under the whole frame for a regression an order of magnitude larger - rebuilding the key
    // as a relationships-times-tables walk measures around 191ms here.
    const perfDoc = state.newDocument('Two hundred tables');

    for (let i = 0; i < 200; i++) {
      const table = fixtureTable('perf-t' + i, 'cs_t' + i, 'Table ' + i, [
        { id: 'perf-c' + i, logicalName: 'cs_parentid', schemaName: 'cs_ParentId',
          displayName: 'Parent', typeName: 'Lookup', isLookup: true, isPrimaryId: false,
          isPrimaryName: false, targets: [], selected: true, status: 'Existing' }
      ]);
      table.x = (i % 20) * 400;
      table.y = Math.floor(i / 20) * 300;
      perfDoc.tables.push(table);
    }

    for (let i = 0; i < 200; i++) {
      const from = i % 200;
      const to = (i * 7 + 3) % 200;
      if (from === to) continue;
      perfDoc.relationships.push({
        id: 'perf-r' + i, schemaName: 'cs_r' + i, kind: 'OneToMany', status: 'Existing',
        fromTableId: 'perf-t' + from, toTableId: 'perf-t' + to,
        referencedAttribute: 'cs_t' + from + 'id', referencingAttribute: 'cs_parentid',
        included: true, hidden: false, waypoints: [], lookupTargets: []
      });
    }

    state.setDocument(perfDoc, null);
    geometry.invalidateSizes();
    render.render();

    // The best of five, not the first: the first frame pays for the text-measurement cache as well,
    // and a budget that includes one-off warm-up costs is a budget about the wrong thing.
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const started = Date.now();
      render.render();
      best = Math.min(best, Date.now() - started);
    }

    check('a two-hundred-table frame stays inside a generous budget', best < 250, best + 'ms');
  }

  // =====================================================================
  console.log('\nFit and the export bounds see the whole drawing');
  // =====================================================================
  //
  // documentBounds covers connectors as well as cards and annotations, so a connector dragged clear
  // of the cards it joins stays inside the export and within reach of Fit. A diagram of sticky notes
  // alone, with no cards at all, can also be fitted rather than resetting to 100% at the default pan.
  {
    const doc = freshDocument('Dragged connector');

    const left = fixtureTable('t-left', 'account', 'Account');
    const right = fixtureTable('t-right', 'contact', 'Contact');

    left.x = 0; left.y = 0;
    right.x = 700; right.y = 0;
    doc.tables.push(left, right);

    const link = {
      id: 'r-dragged', schemaName: 'cs_dragged', kind: 'OneToMany', status: 'Existing',
      fromTableId: left.id, toTableId: right.id,
      // Neither end names a column drawn on its card, so both anchors are the middle of the
      // header - which is what makes the run dead level and the offset lift the whole span.
      referencedAttribute: null, referencingAttribute: null,
      included: true, hidden: false, waypoints: [], lookupTargets: [], routeOffset: 900
    };

    doc.relationships.push(link);
    geometry.invalidateSizes();

    const route = geometry.routeRelationship(link, 0, 1);
    const lowestPoint = Math.max(...route.points.map(p => p.y));
    const lowestCard = Math.max(...doc.tables.map(t => geometry.tableRect(t).y + geometry.tableRect(t).height));

    check('the fixture really is a dead-level run dragged well below both cards',
      route.offsetAxis === 'y' && lowestPoint > lowestCard + 500,
      lowestPoint + ' vs card bottom ' + lowestCard);

    const bounds = geometry.documentBounds(0);

    check('a dragged connector is inside the document bounds',
      bounds.y + bounds.height >= lowestPoint, (bounds.y + bounds.height) + ' vs ' + lowestPoint);

    // And therefore inside the export, which is what the bounds are for.
    check('so it is inside the exported drawing rather than cut off it',
      (() => {
        const viewBox = /viewBox="([-\d. ]+)"/.exec(render.buildExportSvg());
        if (!viewBox) return false;
        const [, y, , height] = viewBox[1].split(' ').map(Number);
        return y + height >= lowestPoint;
      })());

    // ---- a diagram with no cards on it at all

    const sketch = freshDocument('Sticky notes only');

    const note = state.newAnnotation('note', { x: 4000, y: 3000 });
    note.text = 'Phase 2 shape';
    sketch.annotations.push(note);

    check('the fixture is annotations and nothing else',
      sketch.tables.length === 0 && sketch.annotations.length === 1);

    state.state.view.zoom = 1;
    state.state.view.panX = 60;
    state.state.view.panY = 90;

    interactions.fitToView();

    const noteRect = geometry.annotationRect(note);
    const topLeft = interactions.toScreen(noteRect.x, noteRect.y);
    const bottomRight = interactions.toScreen(noteRect.x + noteRect.width, noteRect.y + noteRect.height);

    check('fitting a diagram of sticky notes alone actually brings them on screen',
      topLeft.x >= 0 && topLeft.y >= 0 &&
      bottomRight.x <= window.innerWidth && bottomRight.y <= window.innerHeight,
      JSON.stringify(topLeft) + ' ' + JSON.stringify(bottomRight));
    check('rather than sending the view back to its default pan',
      !(state.state.view.zoom === 1 && state.state.view.panX === 60 && state.state.view.panY === 90),
      JSON.stringify(state.state.view));
  }

  // =====================================================================
  console.log('\nThe open NOTE tag is readable in both themes');
  // =====================================================================
  //
  // The open tag must clear 4.5:1 for its 8px bold text in both themes; a plain inversion - fill
  // becomes the tag's line colour, text becomes the badge fill - gives only 1.81:1 in light and
  // 3.15:1 in dark. Read off the drawn attributes rather than off the palette, so it is the pair
  // the user is looking at that is measured.
  {
    const doc = freshDocument('Note tag contrast');
    const table = fixtureTable('t-noted', 'account', 'Account');
    table.notes = 'Owned by the CRM workstream.';
    doc.tables.push(table);

    const startingTheme = theme.currentTheme();

    for (const name of ['light', 'dark']) {
      theme.setTheme(name);
      render.refreshRendererTheme();
      geometry.invalidateSizes();

      state.state.openNote = table.id;
      render.render();

      const tag = find(document.getElementById('layer-tables'),
        node => node.getAttribute && node.getAttribute('data-note-for') === table.id);
      const plate = tag && find(tag, node => node.tagName === 'rect');
      const label = tag && find(tag, node => node.tagName === 'text');

      check('the open ' + name + ' NOTE tag is drawn with an ink and a fill',
        !!plate && !!label && !!plate.getAttribute('fill') && !!label.getAttribute('fill'),
        plate && plate.getAttribute('fill'));

      const ratio = plate && label
        ? contrast(label.getAttribute('fill'), plate.getAttribute('fill')) : 0;

      check('and its ink clears 4.5:1 on that fill in ' + name,
        ratio >= 4.5, ratio.toFixed(2) + ':1 - ' +
        (label && label.getAttribute('fill')) + ' on ' + (plate && plate.getAttribute('fill')));
    }

    state.state.openNote = null;
    theme.setTheme(startingTheme);
    render.refreshRendererTheme();
    geometry.invalidateSizes();
  }

  // =====================================================================
  console.log('\nA note of nothing but spaces is not a note');
  // =====================================================================
  //
  // The measurer and the renderer must agree on what counts as a note. A note of nothing but
  // whitespace draws no tag, so it must not reserve 44px of header for one and truncate the title
  // to make room for the gap.
  {
    const doc = freshDocument('Whitespace note');
    const table = fixtureTable('t-blank', 'account', 'Account With A Long Enough Name');
    doc.tables.push(table);
    geometry.invalidateSizes();

    table.notes = '';
    const withoutNote = geometry.measureTable(table).width;

    table.notes = '   \t \n  ';
    const withWhitespace = geometry.measureTable(table).width;

    table.notes = 'A real note.';
    const withRealNote = geometry.measureTable(table).width;

    check('a whitespace-only note measures the same width as no note',
      withWhitespace === withoutNote, withoutNote + ' then ' + withWhitespace);

    // The other side of the same contract: a real note does still buy the tag its room, or this
    // check could be passed by never reserving anything.
    check('and a real one still widens the card to fit its tag',
      withRealNote > withoutNote, withoutNote + ' then ' + withRealNote);

    table.notes = '   ';
    render.render();
    check('nothing is drawn for a whitespace note either',
      !serialiseLayer('layer-tables').includes('data-note-for'));
  }

  // =====================================================================
  console.log('\nDeleting a table leaves nothing pointing at what went with it');
  // =====================================================================
  //
  // removeRelationship detaches the annotations attached to the connector it is given. A connector
  // cascaded away by removeTable must get the same treatment, so no sticky note is left with an
  // attachedToId naming a relationship that no longer exists - which would be written to the .dvmd
  // file and reopen pointing at nothing.
  {
    const doc = freshDocument('Cascade detach');

    const going = fixtureTable('t-going', 'account', 'Account');
    const staying = fixtureTable('t-staying', 'contact', 'Contact');
    doc.tables.push(going, staying);

    const link = {
      id: 'r-cascaded', schemaName: 'cs_cascaded', kind: 'OneToMany', status: 'Existing',
      fromTableId: going.id, toTableId: staying.id,
      referencedAttribute: 'accountid', referencingAttribute: 'accountid',
      included: true, hidden: false, waypoints: [], lookupTargets: []
    };
    doc.relationships.push(link);

    const onLink = state.newAnnotation('note', { x: 0, y: 0 }, { attachedToId: link.id });
    const onTable = state.newAnnotation('note', { x: 0, y: 300 }, { attachedToId: going.id });
    const onSurvivor = state.newAnnotation('note', { x: 0, y: 600 }, { attachedToId: staying.id });

    doc.annotations.push(onLink, onTable, onSurvivor);

    check('the fixture has a note on the connector that is about to be cascaded away',
      onLink.attachedToId === link.id &&
      state.state.doc.relationships.some(r => r.id === link.id));

    state.mutate('remove the table', () => state.removeTable(going.id));

    check('the connector went with the table',
      !state.state.doc.relationships.some(r => r.id === link.id));
    check('and the note attached to it is not left holding a dead id',
      onLink.attachedToId === null, String(onLink.attachedToId));
    check('the note attached to the table itself is detached too',
      onTable.attachedToId === null, String(onTable.attachedToId));
    check('and a note on a table that is staying is left alone',
      onSurvivor.attachedToId === staying.id, String(onSurvivor.attachedToId));
  }

  // =====================================================================
  console.log('\nThe canvas shortcuts stop at an open dialog');
  // =====================================================================
  //
  // Opening a dialog focuses nothing that isTypingTarget recognises, so the canvas shortcuts
  // (Delete, Ctrl+A, f and 0) must check for an open dialog themselves. Otherwise Delete destroys
  // the selection behind the backdrop with no confirmation and nothing on screen to show it.
  //
  // Escape is deliberately not carved out as an exception: ui.js listens for it on the document,
  // which is ahead of the window listener interact.js uses, so the dialog still closes.
  {
    const doc = freshDocument('Shortcuts behind a dialog');
    doc.tables.push(fixtureTable('t-1', 'account', 'Account'), fixtureTable('t-2', 'contact', 'Contact'));

    interactions.initInteractions({
      onSelectionChange: () => {},
      onContextMenu: () => {},
      onOpenEditor: () => {},
      onConnect: () => {},
      onAnnotationPlaced: () => {}
    });

    state.selectOnly('tables', 't-1');

    const windowKey = (key, options) => window.dispatchEvent(Object.assign({
      type: 'keydown', key, code: key === ' ' ? 'Space' : 'Key' + key,
      ctrlKey: false, metaKey: false, shiftKey: false,
      target: { tagName: 'DIV' }, preventDefault() {}, stopPropagation() {}
    }, options || {}));

    const documentKey = (key, options) => document.dispatchEvent(Object.assign({
      type: 'keydown', key, ctrlKey: false, metaKey: false, shiftKey: false,
      target: { tagName: 'DIV' }, preventDefault() {}, stopPropagation() {}
    }, options || {}));

    uiModule.openModal({
      title: 'Something modal',
      body: () => {
        const node = document.createElement('div');
        node.textContent = 'A dialog is covering the canvas.';
        return node;
      }
    });

    check('the dialog is on screen', modalOpen());

    windowKey('Delete');

    check('Delete behind an open dialog leaves the tables alone',
      state.state.doc.tables.length === 2, state.state.doc.tables.length + ' tables');
    check('and leaves the selection alone',
      state.state.selection.tables.has('t-1'), state.state.selection.tables.size + ' selected');

    windowKey('a', { ctrlKey: true });
    check('Ctrl+A behind an open dialog does not select the canvas',
      state.state.selection.tables.size === 1, state.state.selection.tables.size + ' selected');

    const viewBefore = JSON.stringify(state.state.view);
    windowKey('f');
    windowKey('0');
    check('and f and 0 do not move the view under it',
      JSON.stringify(state.state.view) === viewBefore, JSON.stringify(state.state.view));

    documentKey('Escape');
    check('Escape still closes the dialog', !modalOpen());

    // With the dialog gone the same key means what it always did, or the guard would just be a way
    // of turning Delete off.
    windowKey('Delete');
    check('and once it has, Delete acts on the canvas again',
      state.state.doc.tables.length === 1, state.state.doc.tables.length + ' tables');

    state.clearSelection();
  }

  // =====================================================================
  console.log('\nTyping in the inspector is one undo step');
  // =====================================================================
  //
  // Every mutate clones the whole document onto the undo stack, so typing in the inspector must be
  // coalesced into one step. One copy per character would push the real edits off the end of a
  // sixty-entry history, and Ctrl+Z would stop meaning "undo what I did".
  {
    const doc = freshDocument('Typing');

    const from = fixtureTable('t-from', 'account', 'Account');
    const to = fixtureTable('t-to', 'contact', 'Contact');
    doc.tables.push(from, to);

    const link = {
      id: 'r-typed', schemaName: 'cs_typed', kind: 'OneToMany', status: 'Existing',
      fromTableId: from.id, toTableId: to.id,
      referencedAttribute: 'accountid', referencingAttribute: 'accountid',
      included: true, hidden: false, waypoints: [], lookupTargets: [], notes: ''
    };
    doc.relationships.push(link);

    state.selectOnly('relationships', link.id);
    inspectorModule.refreshInspector();

    const noteBox = fieldControl(inspectorBody(), 'Note', 'textarea');
    check('the relationship inspector offers a note field', !!noteBox);

    const sentence = 'Cascade delete is deliberately Remove Link.';

    state.resetHistory();
    check('the history starts empty', !state.canUndo());

    type(noteBox, sentence);

    check('typing reaches the document as it happens',
      state.relationshipById(link.id).notes === sentence,
      state.relationshipById(link.id).notes);

    commitField(noteBox);

    check('the typing left something to undo', state.canUndo());

    state.undo();

    check('one undo puts the field back to what it was before the typing started',
      state.relationshipById(link.id).notes === '',
      JSON.stringify(state.relationshipById(link.id).notes));

    // Drained afterwards rather than counted up front, so "it restores the right text" and "there
    // is only one of them" are two separate claims and a break shows up as whichever it broke.
    let entries = 1;
    while (state.canUndo() && entries < 80) { state.undo(); entries++; }

    check('and typing ' + sentence.length + ' characters produced exactly one history entry',
      entries === 1, entries + ' entries');

    state.clearSelection();
    inspectorModule.hideInspector();
  }

  // =====================================================================
  console.log('\nEvery mutating export in proposed.js repaints the inspector');
  // =====================================================================
  //
  // Each one must ask the inspector to repaint, or the inspector goes on showing the old state -
  // including its Status select, which is read from the table when the panel is built.
  //
  // proposed.js raises dmd:refresh-inspector rather than importing the inspector, which would close
  // a module cycle. app.js is what listens for it, and app.js is not importable here, so the same
  // one-line subscription stands in for it.
  {
    const doc = freshDocument('Status repaint');
    const table = fixtureTable('t-status', 'account', 'Account');
    doc.tables.push(table);

    const repaint = () => inspectorModule.refreshInspector();
    window.addEventListener('dmd:refresh-inspector', repaint);

    state.selectOnly('tables', table.id);
    inspectorModule.refreshInspector();

    const before = new XMLSerializer().serializeToString(inspectorBody());
    check('the inspector opens on an existing table', !/DEPRECATED/.test(before));

    proposedModule.setTableStatus(table.id, 'Deprecated');

    const shown = new XMLSerializer().serializeToString(inspectorBody());

    check('marking a table deprecated is reflected in the inspector without reselecting it',
      /DEPRECATED/.test(shown), shown.slice(0, 200));
    check('and the card really did change status', table.status === 'Deprecated', table.status);

    window.removeEventListener('dmd:refresh-inspector', repaint);
    state.clearSelection();
    inspectorModule.hideInspector();
  }

  // =====================================================================
  console.log('\nA right-button pan does not swallow the next right-click');
  // =====================================================================
  //
  // suppressContextMenu is a latch set on the way up from a right-button pan and consumed by the
  // contextmenu event on the canvas. A pan that never produces one - Alt+Tab mid-drag, or a release
  // over a side panel, where pointer capture keeps pointerup on the canvas while contextmenu goes to
  // the element under the cursor - must not leave it armed, so it is cleared where the gesture
  // starts; otherwise the next right-click opens nothing.
  {
    const doc = freshDocument('Right-click');
    doc.tables.push(fixtureTable('t-only', 'account', 'Account'));

    let menus = 0;

    interactions.initInteractions({
      onSelectionChange: () => {},
      onContextMenu: () => { menus++; },
      onOpenEditor: () => {},
      onConnect: () => {},
      onAnnotationPlaced: () => {}
    });

    const canvasNode = document.getElementById('canvas');
    const nowhere = { closest: () => null, tagName: 'svg' };

    // initInteractions has now been called more than once in this run, so the canvas carries the
    // same handler several times over. Dispatching to the distinct handlers gives each event
    // exactly one delivery, which is what a browser does.
    const canvasEvent = (eventType, x, y, options) => {
      const event = Object.assign({
        type: eventType, pointerId: 1, clientX: x, clientY: y, button: 0,
        shiftKey: false, ctrlKey: false, altKey: false, target: nowhere,
        preventDefault() {}, stopPropagation() {}
      }, options || {});

      for (const handler of new Set(canvasNode.listeners[eventType] || [])) handler(event);
    };

    // A right-button pan that ends without a contextmenu ever arriving.
    canvasEvent('pointerdown', 400, 400, { button: 2 });
    canvasEvent('pointermove', 520, 460, { button: 2 });
    canvasEvent('pointercancel', 520, 460, { button: 2 });

    check('the pan moved the canvas, so it really was a pan',
      state.state.view.panX !== 60 || state.state.view.panY !== 90,
      JSON.stringify(state.state.view));

    menus = 0;

    // The next right-click, in full. Chromium raises contextmenu on press outside Windows - which is
    // why interact.js holds the menu until the button comes up - so this is the order that reaches the
    // latch: down, contextmenu, up. On the release order the pointerup resets the latch on its way
    // past, so that sequence would prove nothing.
    canvasEvent('pointerdown', 300, 300, { button: 2 });
    canvasEvent('contextmenu', 300, 300, { button: 2 });
    canvasEvent('pointerup', 300, 300, { button: 2 });

    check('the right-click after a pan that was cancelled still opens a menu',
      menus === 1, menus + ' menus');

    // And a pan that does end in a contextmenu still suppresses that one, or the guard would just be
    // "always show the menu".
    canvasEvent('pointerdown', 400, 400, { button: 2 });
    canvasEvent('pointermove', 600, 500, { button: 2 });
    canvasEvent('pointerup', 600, 500, { button: 2 });

    menus = 0;
    canvasEvent('contextmenu', 600, 500, { button: 2 });

    check('while the menu at the end of a pan is still suppressed', menus === 0, menus + ' menus');
  }

  // =====================================================================
  console.log('\nLosing focus with Space held does not leave the canvas in pan mode');
  // =====================================================================
  //
  // Space held is a modifier, and a modifier the window never sees released would stay stuck on:
  // hold Space, Alt+Tab away, let go over another window, come back, and a plain left-drag would pan
  // instead of drawing a marquee. Losing focus clears it.
  {
    const doc = freshDocument('Space held');
    doc.tables.push(fixtureTable('t-one', 'account', 'Account'));

    const canvasNode = document.getElementById('canvas');
    const nowhere = { closest: () => null, tagName: 'svg' };

    const canvasEvent = (eventType, x, y, options) => {
      const event = Object.assign({
        type: eventType, pointerId: 1, clientX: x, clientY: y, button: 0,
        shiftKey: false, ctrlKey: false, altKey: false, target: nowhere,
        preventDefault() {}, stopPropagation() {}
      }, options || {});

      for (const handler of new Set(canvasNode.listeners[eventType] || [])) handler(event);
    };

    window.dispatchEvent({
      type: 'keydown', key: ' ', code: 'Space', ctrlKey: false, metaKey: false, shiftKey: false,
      target: { tagName: 'DIV' }, preventDefault() {}, stopPropagation() {}
    });

    check('holding Space arms the pan cursor', canvasNode.classList.contains('is-pan-ready'));

    window.dispatchEvent({ type: 'blur' });

    check('a window blur takes the pan cursor off again',
      !canvasNode.classList.contains('is-pan-ready'));

    // The cursor is the sign; this is the behaviour. A left-drag on empty canvas has to be a
    // marquee again rather than a pan.
    const panBefore = { x: state.state.view.panX, y: state.state.view.panY };

    canvasEvent('pointerdown', 200, 200);
    canvasEvent('pointermove', 500, 400);
    canvasEvent('pointerup', 500, 400);

    check('and a left-drag on empty canvas is a marquee again rather than a pan',
      state.state.view.panX === panBefore.x && state.state.view.panY === panBefore.y,
      JSON.stringify(state.state.view) + ' from ' + JSON.stringify(panBefore));
  }

  // =====================================================================
  console.log('\nA dialog takes focus, keeps its handle to itself, and hands its onClose back');
  // =====================================================================
  {
    uiModule.closeModal();

    // ---- focus

    const buttonBody = () => {
      const wrap = document.createElement('div');
      const button = document.createElement('button');
      button.textContent = 'Inside the dialog';
      wrap.appendChild(button);
      return wrap;
    };

    document.activeElement = null;

    uiModule.openModal({ title: 'Focus', body: buttonBody });

    check('a dialog puts focus on something inside itself',
      !!document.activeElement && modal().contains(document.activeElement),
      document.activeElement && document.activeElement.tagName);
    check('and not on the close cross, which Enter would then throw the dialog away with',
      !!document.activeElement && !document.activeElement.classList.contains('icon-btn'),
      document.activeElement && document.activeElement.getAttribute('class'));

    uiModule.closeModal();

    // ---- a dialog opened over another

    let closedWith = 'never';
    let closes = 0;

    uiModule.openModal({
      title: 'Outgoing',
      body: buttonBody,
      onClose: result => { closes++; closedWith = result; }
    });

    uiModule.openModal({ title: 'Incoming', body: buttonBody });

    check('opening a dialog over another tells the outgoing one it has gone',
      closes === 1, closes + ' calls, with ' + JSON.stringify(closedWith));
    check('and the incoming dialog is the one on screen',
      /Incoming/.test(modalText()) && !/Outgoing/.test(modalText()));

    uiModule.closeModal();

    // ---- a stale api handle

    const stale = uiModule.openModal({
      title: 'Dismissed', subtitle: 'the old one', body: buttonBody
    });

    uiModule.openModal({ title: 'Standing', subtitle: 'the new one', body: buttonBody });

    stale.setSubtitle('HIJACKED');

    check('a dismissed dialog\'s handle cannot repaint the dialog that replaced it',
      !/HIJACKED/.test(modalText()) && /the new one/.test(modalText()),
      (/the new one|HIJACKED/.exec(modalText()) || [''])[0]);

    stale.setPrimaryEnabled(false);
    stale.close('from the wrong dialog');

    check('and cannot close it either', modalOpen() && /Standing/.test(modalText()));

    uiModule.closeModal();

    // ---- checkbox()

    const ticks = [];
    const box = uiModule.checkbox('A tick box', false, value => ticks.push(value));

    check('a tick box is reachable by Tab', box.getAttribute('tabindex') === '0',
      String(box.getAttribute('tabindex')));
    check('and says what it is', box.getAttribute('role') === 'checkbox',
      String(box.getAttribute('role')));
    check('and says whether it is ticked', box.getAttribute('aria-checked') === 'false',
      String(box.getAttribute('aria-checked')));

    const keyed = fire(box, 'keydown', { key: 'Enter' });

    check('and Enter is wired to something', keyed);
    check('and Enter ticks it', ticks.length === 1 && ticks[0] === true, JSON.stringify(ticks));
    check('and the state it reports keeps up',
      box.getAttribute('aria-checked') === 'true', String(box.getAttribute('aria-checked')));

    fire(box, 'keydown', { key: ' ' });
    check('and Space unticks it again', ticks.length === 2 && ticks[1] === false, JSON.stringify(ticks));
  }

  // =====================================================================
  console.log('\nA card header does not draw its schema name twice');
  // =====================================================================
  //
  // The subtitle is suppressed when it would repeat the title - including the configuration where
  // the title *is* the schema name (display names off, schema names on), so the guard must not also
  // depend on showTableDisplayName.
  {
    const doc = freshDocument('Header names');
    const table = fixtureTable('t-header', 'cs_widget', 'Widget');
    doc.tables.push(table);

    state.state.doc.settings.showTableDisplayName = false;
    state.state.doc.settings.showTableSchemaName = true;
    geometry.invalidateSizes();

    check('the title is the schema name in this configuration',
      geometry.tableTitle(table) === 'cs_widget', geometry.tableTitle(table));
    check('so the subtitle offers nothing to draw',
      !geometry.tableSubtitle(table), String(geometry.tableSubtitle(table)));

    render.render();
    const header = serialiseLayer('layer-tables');
    // Matched as a whole text node: the card's primary key column is cs_widgetid, and a substring
    // count would find the name inside it and report a duplicate that is not one.
    const occurrences = (header.match(/>cs_widget</g) || []).length;

    check('and the card draws the name once, not twice', occurrences === 1, occurrences + ' times');

    // With display names on the subtitle is the whole point of the setting, so it still appears -
    // or the check above could be passed by a function that always returns null.
    state.state.doc.settings.showTableDisplayName = true;
    geometry.invalidateSizes();

    check('with display names on, the schema name is still offered as a subtitle',
      geometry.tableSubtitle(table) === 'cs_widget', String(geometry.tableSubtitle(table)));

    state.state.doc.settings.showTableDisplayName = true;
    state.state.doc.settings.showTableSchemaName = true;
    geometry.invalidateSizes();
  }

  // =====================================================================
  console.log('\nThe explorer\'s bulk controls and its count are about the same rows');
  // =====================================================================
  //
  // Select all and Clear act on the filtered rows, so commit() and the footer count must too.
  // Otherwise Clear beside a one-row filtered list looks as though it has emptied the selection
  // while leaving 39 of the 40 tables about to be added still ticked.
  {
    freshDocument('Explorer scope');

    const catalogue = [
      { logicalName: 'account', displayName: 'Account', schemaName: 'Account', isCustom: false },
      { logicalName: 'contact', displayName: 'Contact', schemaName: 'Contact', isCustom: false },
      { logicalName: 'cs_widget', displayName: 'Widget', schemaName: 'cs_Widget', isCustom: true }
    ];

    const summary = name => Object.assign({ isActivity: false, isIntersect: false },
      catalogue.find(t => t.logicalName === name));

    sourcepickerModule.invalidateCatalogue();
    state.state.connection = { connected: true, organizationFriendlyName: 'Verify', host: 'verify' };

    bridge.host.listTables = async () => catalogue;
    bridge.host.exploreGraph = async () => ({
      message: '', filteredOut: 0,
      tables: [
        { summary: summary('account'), hops: 0, degree: 2, via: [] },
        { summary: summary('contact'), hops: 1, degree: 1, via: ['a_contact'] },
        { summary: summary('cs_widget'), hops: 1, degree: 1, via: ['a_widget'] }
      ]
    });

    explorerModule.openExplorer();
    await settle();

    check('the explorer opened on its settings', /What is this table connected to/.test(modalText()));
    check('and Explore ran', clickByText(modal(), 'Explore'));
    await settle();

    const resultsBody = () => find(modal(), node =>
      node.classList && node.classList.contains('modal-body'));
    const footText = () => {
      const foot = find(modal(), node => node.classList && node.classList.contains('modal-foot'));
      return foot ? String(foot.textContent) : '';
    };
    const tickedRows = () => findAll(resultsBody(), node =>
      node.classList && node.classList.contains('row') &&
      node.getAttribute('aria-checked') === 'true').length;
    const leadingCount = text => {
      const match = /(\d+)/.exec(text);
      return match ? Number(match[1]) : -1;
    };

    check('three tables came back, all ticked', tickedRows() === 3, tickedRows() + ' ticked');

    const filterBox = find(modal(), node =>
      node.tagName === 'input' && node.getAttribute('type') === 'search');

    check('the results carry a filter box', !!filterBox);

    filterBox.value = 'Widget';
    fire(filterBox, 'input');
    await after(200);

    check('the filter narrows the list to one row',
      findAll(resultsBody(), node => node.classList && node.classList.contains('row')).length === 1,
      findAll(resultsBody(), node => node.classList && node.classList.contains('row')).length + ' rows');
    check('and the footer counts the rows that are on screen, not the whole walk',
      leadingCount(footText()) === tickedRows(),
      footText() + ' against ' + tickedRows() + ' ticked on screen');

    check('Clear is offered', clickByText(modal(), 'Clear'));

    check('after Clear the footer and the rows still agree',
      leadingCount(footText()) === tickedRows(),
      footText() + ' against ' + tickedRows() + ' ticked on screen');
    check('and Clear really did untick the filtered row', tickedRows() === 0, tickedRows() + ' ticked');

    uiModule.closeModal();
    state.state.connection = { connected: false };
    sourcepickerModule.invalidateCatalogue();
  }

  // =====================================================================
  console.log('\n"Select all shown" means the rows that are shown');
  // =====================================================================
  //
  // The list renders the first 1200 matches, so the button ticks only those. Ticking every match
  // would, on a 3000-table environment, select tables nobody can see and commit 3000 metadata reads,
  // and the truncation notice sits below 1200 rows inside a scrolling list, off screen.
  {
    freshDocument('Row cap');

    const many = [];
    for (let i = 0; i < 1500; i++) {
      many.push({
        logicalName: 'cs_row' + String(i).padStart(4, '0'),
        schemaName: 'cs_Row' + i,
        displayName: 'Row ' + String(i).padStart(4, '0'),
        isCustom: true, isActivity: false, isIntersect: false
      });
    }

    sourcepickerModule.invalidateCatalogue();
    state.state.connection = { connected: true, organizationFriendlyName: 'Verify', host: 'verify' };
    bridge.host.listTables = async () => many;

    sourcepickerModule.openSourcePicker({ mode: 'new' });
    await settle();

    check('the wizard opens on its starting point',
      /What should this diagram be built from/.test(modalText()));
    check('the whole-environment card is offered', clickByText(modal(), 'Selected tables'));
    await settle();

    check('and the table chooser has more matches than it renders',
      /Showing the first 1200 of 1500 matches/.test(modalText()),
      (/Showing the first[^<]*/.exec(modalText()) || [''])[0]);

    check('Select all shown is offered', clickByText(modal(), 'Select all shown'));

    const countText = (/(\d+) selected/.exec(modalText()) || [])[1];

    check('and it ticks the rows that are rendered rather than every match',
      Number(countText) === 1200, countText + ' selected');

    uiModule.closeModal();
    state.state.connection = { connected: false };
    sourcepickerModule.invalidateCatalogue();
  }

  // =====================================================================
  console.log('\nThe table filter is debounced');
  // =====================================================================
  //
  // Re-filtering the whole catalogue and rebuilding up to 1200 rows on every keystroke is felt as
  // the field lagging behind the typing on a catalogue of three thousand tables, so the filter
  // waits for a pause.
  {
    freshDocument('Debounce');

    const catalogue = [];
    for (let i = 0; i < 30; i++) {
      catalogue.push({
        logicalName: 'cs_account' + i, schemaName: 'cs_Account' + i,
        displayName: 'Account ' + i, isCustom: true, isActivity: false, isIntersect: false
      });
    }

    sourcepickerModule.invalidateCatalogue();
    state.state.connection = { connected: true, organizationFriendlyName: 'Verify', host: 'verify' };
    bridge.host.listTables = async () => catalogue;

    sourcepickerModule.openSourcePicker({ mode: 'new' });
    await settle();
    clickByText(modal(), 'Selected tables');
    await settle();

    const listWrap = find(modal(), node =>
      node.classList && node.classList.contains('wizard-list') && node.classList.contains('grow'));

    check('the table chooser rendered its list', !!listWrap);

    // Counting the grid the list is repainted with is the only honest way to count repaints from
    // outside: paint() clears the wrapper and appends exactly one <table> to it.
    let repaints = 0;
    const append = listWrap.appendChild.bind(listWrap);
    listWrap.appendChild = child => { if (child.tagName === 'table') repaints++; return append(child); };

    const searchBox = find(modal(), node =>
      node.tagName === 'input' && node.getAttribute('type') === 'search');

    check('the table chooser carries a filter box', !!searchBox);

    for (const text of ['a', 'ac', 'acc', 'acco', 'accou']) {
      searchBox.value = text;
      fire(searchBox, 'input');
    }

    check('nothing is repainted while the keys are still arriving', repaints === 0, repaints + ' repaints');

    await after(250);

    check('a burst of five keystrokes repaints the list once, not once per keystroke',
      repaints === 1, repaints + ' repaints');
    check('and the repaint it did do used the last thing typed',
      /Account 1</.test(new XMLSerializer().serializeToString(listWrap)) ||
      /cs_account1/.test(new XMLSerializer().serializeToString(listWrap)));

    uiModule.closeModal();
    state.state.connection = { connected: false };
    sourcepickerModule.invalidateCatalogue();
  }

  // =====================================================================
  console.log('\nA dialog dismissed while it was loading stops working');
  // =====================================================================
  //
  // ui.js's Escape handler is on the document, so it closes a dialog straight through whatever that
  // dialog is waiting on. When the explorer comes back from reading the catalogue it must not walk
  // the graph and paint the answer into a modal root that by then belongs to whatever the user
  // opened next.
  {
    freshDocument('Dismissed mid-load');

    const catalogue = [
      { logicalName: 'account', displayName: 'Account', schemaName: 'Account', isCustom: false }
    ];

    let releaseCatalogue = null;
    let walks = 0;

    sourcepickerModule.invalidateCatalogue();
    state.state.connection = { connected: true, organizationFriendlyName: 'Verify', host: 'verify' };

    bridge.host.listTables = () => new Promise(resolve => { releaseCatalogue = () => resolve(catalogue); });
    bridge.host.exploreGraph = async () => {
      walks++;
      return {
        message: '', filteredOut: 0,
        tables: [{
          summary: { logicalName: 'account', displayName: 'Account', schemaName: 'Account',
            isCustom: false, isActivity: false, isIntersect: false },
          hops: 0, degree: 0, via: []
        }]
      };
    };

    // A start table, so the dialog walks by itself the moment the catalogue lands - which is the
    // race this is about.
    explorerModule.openExplorer('account');
    await settle();

    check('the explorer is on screen and waiting for the catalogue',
      modalOpen() && releaseCatalogue !== null && walks === 0, walks + ' walks');

    document.dispatchEvent({
      type: 'keydown', key: 'Escape', target: { tagName: 'DIV' },
      preventDefault() {}, stopPropagation() {}
    });

    check('Escape dismisses it while the read is still in flight', !modalOpen());

    // Whatever the user opened next. The explorer's continuation must not touch it.
    uiModule.openModal({
      title: 'The next dialog',
      body: () => {
        const node = document.createElement('div');
        node.textContent = 'STILL MINE';
        return node;
      }
    });

    releaseCatalogue();
    await settle();

    check('the walk a dismissed dialog was about to start does not run', walks === 0, walks + ' walks');
    check('and the dialog that replaced it is untouched',
      /STILL MINE/.test(modalText()) && !/Hide platform plumbing/.test(modalText()) &&
      !/Hop 1/.test(modalText()),
      modalText().slice(0, 200));

    uiModule.closeModal();
    state.state.connection = { connected: false };
    sourcepickerModule.invalidateCatalogue();
  }

  // =====================================================================
  console.log('\nThe path finder never opens on a blank From box');
  // =====================================================================
  //
  // The From and To lists are capped at 500 tables, and the two values are seeded from the canvas
  // and the selection - which are independent of that list. A seeded table past the cap must still
  // appear, or the select sits at index -1 and renders blank while Search uses the hidden value.
  {
    const doc = freshDocument('Path finder seeding');

    // Exactly one table with a logical name, so the dialog falls back to the capped catalogue list
    // rather than to the tables on the canvas.
    doc.tables.push(fixtureTable('t-late', 'zz_late', 'ZZZ Late Table'));

    const big = [];
    for (let i = 0; i < 600; i++) {
      big.push({
        logicalName: 'cs_t' + String(i).padStart(3, '0'),
        schemaName: 'cs_T' + i,
        displayName: 'Table ' + String(i).padStart(3, '0'),
        isCustom: true, isActivity: false, isIntersect: false
      });
    }
    big.push({
      logicalName: 'zz_late', schemaName: 'ZzLate', displayName: 'ZZZ Late Table',
      isCustom: true, isActivity: false, isIntersect: false
    });

    sourcepickerModule.invalidateCatalogue();
    state.state.connection = { connected: true, organizationFriendlyName: 'Verify', host: 'verify' };
    bridge.host.listTables = async () => big;

    await dialogsModule.openPathFinder();
    await settle();

    check('the path finder built', /How are these two tables connected/.test(modalText()));
    check('and says its list is capped',
      /Showing the first 500 of 601 tables/.test(modalText()),
      (/Showing the first[^<]*/.exec(modalText()) || [''])[0]);

    const selects = findAll(modal(), node => node.tagName === 'select');
    const fromBox = selects[0];
    const offered = fromBox
      ? fromBox.childNodes.filter(n => n.tagName === 'option').map(n => n.value)
      : [];

    check('the From box was built', !!fromBox && offered.length > 0, offered.length + ' options');
    check('the seeded table is one of the options rather than a hidden value',
      offered.includes('zz_late'),
      offered.length + ' options, first ' + offered.slice(0, 2).join(','));
    check('and it is the one selected, so the box is not blank',
      fromBox && fromBox.value === 'zz_late', fromBox && fromBox.value);

    uiModule.closeModal();
    state.state.connection = { connected: false };
    sourcepickerModule.invalidateCatalogue();
  }

  // =====================================================================
  console.log('\nA solution with no tables in it says so');
  // =====================================================================
  //
  // Picking a solution resets the filter, so a solution that contains no tables must say so rather
  // than report "No tables match the current filter" beside an empty filter box.
  {
    freshDocument('Empty solution');

    sourcepickerModule.invalidateCatalogue();
    state.state.connection = { connected: true, organizationFriendlyName: 'Verify', host: 'verify' };

    bridge.host.listSolutions = async () => ([{
      id: 's-empty', friendlyName: 'Reporting extensions', uniqueName: 'cs_reporting',
      publisher: 'Verify', version: '1.0.0.0', isManaged: false
    }]);
    bridge.host.listTables = async solutionId => (solutionId === 's-empty' ? [] : []);

    sourcepickerModule.openSourcePicker({ mode: 'new' });
    await settle();

    check('the solution route is offered', clickByText(modal(), 'A solution'));
    await settle();

    check('the solution list built', /Which solution/.test(modalText()));
    check('the empty solution can be picked', clickRow(modal(), 'Reporting extensions'));
    await settle();

    const shown = modalText();

    check('an empty solution is named rather than blamed on a filter nobody set',
      /Reporting extensions contains no tables/.test(shown),
      (/empty-note[^>]*>([^<]*)/.exec(shown) || ['', ''])[1]);
    check('and the message about a filter is not shown, because no filter is set',
      !/No tables match the current filter/.test(shown));

    uiModule.closeModal();
    state.state.connection = { connected: false };
    sourcepickerModule.invalidateCatalogue();
  }

  // =====================================================================
  console.log('\nSmall text clears 4.5:1 in both themes');
  // =====================================================================
  //
  // The light quiet inks (--ink-5 and --ink-4 on --surface-2, --proposed-ink on --proposed-fill) and
  // .connect-banner's text over --accent must all clear 4.5:1 - the banner in dark too, where the
  // accent is a pale blue and white text on it would not.
  //
  // Parsed out of app.css and computed, rather than trusting the ratios written in its comments.
  {
    const cssSource = fsModule
      .readFileSync('../../src/Oliver4.DataModelDesigner/Web/css/app.css', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    const blockOf = selector => {
      const start = cssSource.indexOf(selector + ' {');
      if (start < 0) return '';
      return cssSource.slice(start, cssSource.indexOf('\n}', start));
    };

    const variablesIn = block => {
      const map = {};
      for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) map[match[1]] = match[2].trim();
      return map;
    };

    const light = variablesIn(blockOf(':root'));
    const dark = variablesIn(blockOf('body.theme-dark'));

    check('both theme blocks were found and carry the quiet inks',
      !!light['--ink-5'] && !!dark['--ink-5'] && !!light['--surface-2'] && !!dark['--surface-2'],
      Object.keys(light).length + ' light, ' + Object.keys(dark).length + ' dark');

    const inks = ['--ink-3', '--ink-4', '--ink-5'];

    // Not just white. The quiet inks are drawn on the tinted status fills as well, and those are
    // lighter than --surface-2 - so a pair pitched against white can pass by eye and fail where it is
    // actually used.
    const lightSurfaces = ['--surface', '--surface-2',
      '--proposed-fill', '--external-fill', '--deprecated-fill', '--ok-fill'];

    for (const ink of inks) {
      const worst = lightSurfaces
        .map(surface => ({ surface, ratio: contrast(light[ink], light[surface]) }))
        .sort((a, b) => a.ratio - b.ratio)[0];

      check('light ' + ink + ' clears 4.5:1 on every surface it is drawn on',
        worst.ratio >= 4.5,
        light[ink] + ' on ' + worst.surface + ' (' + light[worst.surface] + ') is ' +
        worst.ratio.toFixed(2) + ':1');
    }

    for (const ink of inks) {
      const worst = ['--surface', '--surface-2']
        .map(surface => ({ surface, ratio: contrast(dark[ink], dark[surface]) }))
        .sort((a, b) => a.ratio - b.ratio)[0];

      check('dark ' + ink + ' still clears 4.5:1',
        worst.ratio >= 4.5,
        dark[ink] + ' on ' + worst.surface + ' (' + dark[worst.surface] + ') is ' +
        worst.ratio.toFixed(2) + ':1');
    }

    for (const [name, variables] of [['light', light], ['dark', dark]]) {
      const ratio = contrast(variables['--proposed-ink'], variables['--proposed-fill']);
      check(name + ' --proposed-ink clears 4.5:1 on --proposed-fill', ratio >= 4.5,
        variables['--proposed-ink'] + ' on ' + variables['--proposed-fill'] + ' is ' +
        ratio.toFixed(2) + ':1');
    }

    // The header of app.css claims nothing below the variable blocks hard-codes a colour. That claim
    // is what makes a new theme a variable block rather than a sweep through the file.
    const below = cssSource.slice(cssSource.indexOf('\n}', cssSource.indexOf('body.theme-dark {')));
    const declarations = Array.from(below.matchAll(/(?:^|[;{\s])color\s*:\s*([^;}]+)/g))
      .map(match => match[1].trim());

    const hardCoded = declarations.filter(value =>
      !/^var\(/.test(value) && !/^(inherit|transparent|currentcolor)$/i.test(value));

    check('there are text colours below the variable blocks to check at all',
      declarations.length > 20, declarations.length + ' declarations');
    check('and every one of them is a variable rather than a literal colour',
      hardCoded.length === 0, hardCoded.join(', '));
  }

  // ------------------------------------------ wizard, branding, sticky notes ----
  //
  // Driven with the plumbing above rather than a copy of it: these are the same dialogs and the
  // same modules, and a second harness would only be a second thing to drift. Everything reachable
  // by importing a module is pinned behaviourally; app.js is read as source, for the reason
  // "Boot-order safety in app.js" gives below.

  /** A catalogue of n plausible tables, for the wizard's list-length rules. */
  const catalogueOf = count => Array.from({ length: count }, (unused, index) => ({
    logicalName: 'cs_table' + index,
    schemaName: 'cs_Table' + index,
    displayName: 'Table ' + index,
    isCustom: true, isActivity: false, isIntersect: false
  }));

  /** The wizard's own running total, read off the actions row it draws it in. */
  const wizardSelectedCount = () => {
    const match = /(\d+) selected/.exec(modalText());
    return match ? Number(match[1]) : -1;
  };

  /** Opens the wizard on its table chooser, over a catalogue of the given size. */
  const openTableChooser = async count => {
    freshDocument('Wizard over ' + count);
    sourcepickerModule.invalidateCatalogue();
    state.state.connection = { connected: true, organizationFriendlyName: 'Verify', host: 'verify' };
    bridge.host.listTables = async () => catalogueOf(count);

    sourcepickerModule.openSourcePicker({ mode: 'new' });
    clickByText(modal(), 'Selected tables');
    await settle();
  };

  // =====================================================================
  console.log('\nThe new diagram wizard ticks a short list of tables and leaves a long one alone');
  // =====================================================================
  //
  // Ticking the whole list is right for a solution with thirty tables in it and wrong for an
  // environment with three thousand, so the chooser only offers it below AUTO_TICK_LIMIT. Both
  // sides of the boundary are pinned: a limit only ever tested from one side is a limit that can be
  // moved, or dropped, without anything noticing.
  {
    await openTableChooser(199);

    check('a list below the auto-tick limit reaches the table chooser',
      /Which tables\?/.test(modalText()), modalText().slice(0, 200));
    check('and every table on it starts ticked',
      wizardSelectedCount() === 199, wizardSelectedCount() + ' of 199 selected');
    check('and the lead says the ticks are the default rather than a choice already made',
      /Everything is ticked by default/.test(modalText()));

    uiModule.closeModal();

    await openTableChooser(200);

    check('at the limit nothing is ticked',
      wizardSelectedCount() === 0, wizardSelectedCount() + ' selected');
    check('and the lead says why, rather than leaving an empty list unexplained',
      /too many to tick for you/.test(modalText()),
      (/<p[^>]*>[^<]*ticked[^<]*<\/p>/.exec(modalText()) || [''])[0]);

    uiModule.closeModal();
  }

  // =====================================================================
  console.log('\nThe default ticks are offered once per list, not once per visit');
  // =====================================================================
  //
  // Stepping forward to the relationships step and back again must not re-run the seeding, or every
  // table the user had just unticked comes back. selectionSeeded is what remembers that the offer
  // has been made; every path that empties the selection - a different starting point, a different
  // solution - clears it again, because a different list of tables is owed the offer afresh.
  //
  // Both guards in seedTableSelection are covered below, but they overlap: the size guard alone
  // holds every state this wizard can be steered into, because "Next: relationships" is disabled
  // on an empty selection, so a visit with nothing ticked cannot be reached by pressing anything.
  // Take both guards away and the first check below reports 30 tables where the user left one. Take
  // only the flag away and nothing here moves.
  {
    await openTableChooser(30);

    bridge.host.discoverRelationships = async () => [];

    check('a short list is ticked for you', wizardSelectedCount() === 30, wizardSelectedCount() + '');
    check('Clear empties it', clickByText(modal(), 'Clear') && wizardSelectedCount() === 0,
      wizardSelectedCount() + '');

    // One row ticked by hand: the wizard will not step forward on an empty selection, so this is
    // the state a user is actually in when they come back to the list they have just pruned.
    clickRow(modal(), 'Table 17');
    check('one table ticked by hand', wizardSelectedCount() === 1, wizardSelectedCount() + '');

    clickByText(modal(), 'Next: relationships');
    await settle();

    check('the relationships step was reached',
      /Which relationships should be drawn\?/.test(modalText()), modalText().slice(0, 200));

    clickByText(modal(), 'Back');
    await settle();

    check('and coming back leaves the selection exactly as it was left',
      wizardSelectedCount() === 1, wizardSelectedCount() + ' selected');
    check('so the one table ticked by hand is still the only one ticked',
      /Table 17/.test(modalText()) && wizardSelectedCount() === 1);

    uiModule.closeModal();

    // The other half of the same rule. A different solution is a different list of tables, so the
    // offer is owed again - and it is only owed because picking one clears the flag as well as the
    // selection.
    freshDocument('Wizard solutions');
    sourcepickerModule.invalidateCatalogue();
    state.state.connection = { connected: true, organizationFriendlyName: 'Verify', host: 'verify' };

    const solutionTables = { 'sol-a': catalogueOf(12), 'sol-b': catalogueOf(9) };

    bridge.host.listSolutions = async () => [
      { id: 'sol-a', friendlyName: 'Alpha', uniqueName: 'alpha', publisher: 'Verify', version: '1.0' },
      { id: 'sol-b', friendlyName: 'Bravo', uniqueName: 'bravo', publisher: 'Verify', version: '1.0' }
    ];
    bridge.host.listTables = async solutionId => solutionTables[solutionId] || [];

    sourcepickerModule.openSourcePicker({ mode: 'new' });
    clickByText(modal(), 'A solution');
    await settle();

    check('the solution step lists the solutions', /Which solution\?/.test(modalText()));

    clickRow(modal(), 'Alpha');
    await settle();

    check('the first solution arrives with its tables ticked',
      wizardSelectedCount() === 12, wizardSelectedCount() + ' selected');

    clickByText(modal(), 'Clear');
    check('and they can be cleared', wizardSelectedCount() === 0, wizardSelectedCount() + '');

    clickByText(modal(), 'Back');
    await settle();
    clickRow(modal(), 'Bravo');
    await settle();

    check('a different solution is a new list, so it is seeded rather than arriving empty',
      wizardSelectedCount() === 9, wizardSelectedCount() + ' of 9 selected');

    uiModule.closeModal();
  }

  // =====================================================================
  console.log('\nA large table selection is confirmed before the relationships step');
  // =====================================================================
  //
  // The next step reads live metadata for every ticked table, one request each, so clicking
  // straight through a list that was ticked for you is slow as well as unreadable once it is drawn.
  // Past CONFIRM_SELECTION_LIMIT the wizard asks first.
  //
  // What is pinned is the answer the user gets - the question, the number in it, and that saying no
  // leaves them where they were with what they had. How the question is put is not pinned; it is
  // asked through the host rather than through a second openModal only because openModal replaces
  // whatever is open, which would take the wizard and the selection with it. "The wizard is still
  // there afterwards" below is that consequence, stated as behaviour.
  {
    let asked = [];
    let answer = false;

    bridge.host.confirm = async (caption, text) => { asked.push({ caption, text }); return answer; };
    bridge.host.discoverRelationships = async () => [];

    const openAndTick = async count => {
      await openTableChooser(count);
      asked = [];
    };

    await openAndTick(20);
    check('twenty tables are ticked without a word', wizardSelectedCount() === 20, wizardSelectedCount() + '');

    clickByText(modal(), 'Next: relationships');
    await settle();

    check('a selection at the limit is not asked about', asked.length === 0, asked.length + ' questions');
    check('and it goes straight through to the relationships step',
      /Which relationships should be drawn\?/.test(modalText()));

    uiModule.closeModal();

    await openAndTick(21);
    clickByText(modal(), 'Next: relationships');
    await settle();

    check('one table past the limit is asked about', asked.length === 1, asked.length + ' questions');

    uiModule.closeModal();

    // The number in the question is the number of tables ticked, not the limit that triggered it.
    await openAndTick(24);
    answer = false;
    clickByText(modal(), 'Next: relationships');
    await settle();

    const question = asked.length ? asked[0].text : '';

    check('the question names how many tables are actually ticked',
      /You have 24 tables ticked/.test(question), question);
    check('and asks about that same number rather than about the limit',
      /Add all 24\?/.test(question), question);

    check('saying no stays on the table chooser',
      /Which tables\?/.test(modalText()), modalText().slice(0, 200));
    check('and the wizard is still there afterwards, with its steps intact',
      /wizard-steps/.test(modalText()));
    check('with the selection untouched, so it can be changed rather than rebuilt',
      wizardSelectedCount() === 24, wizardSelectedCount() + ' selected');

    answer = true;
    clickByText(modal(), 'Next: relationships');
    await settle();

    check('and saying yes goes on to the relationships step',
      /Which relationships should be drawn\?/.test(modalText()), modalText().slice(0, 200));

    uiModule.closeModal();
  }

  // =====================================================================
  console.log('\nThe New diagram dialog wears the product lockup');
  // =====================================================================
  //
  // The tool opens straight into this dialog, so it is the first thing anyone sees of the product.
  // It uses the same four classes the About box and the feature guide use, so app.css styles one
  // lockup rather than three.
  {
    freshDocument('Brand');
    sourcepickerModule.invalidateCatalogue();
    state.state.connection = { connected: false };

    theme.setTheme('light');
    sourcepickerModule.openSourcePicker({ mode: 'new' });

    const light = modalText();

    check('the wizard body carries the shared lockup',
      /class="guide-head"/.test(light) && /class="guide-logo"/.test(light) &&
      /class="brand-eyebrow"/.test(light) && /class="guide-name"/.test(light),
      light.slice(0, 400));
    check('with the brand above the tool name',
      light.indexOf('OLIVER4') >= 0 &&
      light.indexOf('OLIVER4') < light.indexOf('Data Model Designer'));
    check('and it names the tool rather than the step',
      /Data Model Designer/.test(light));
    check('the name is not repeated after the OLIVER4 eyebrow',
      !/Oliver4 Data Model Designer/.test(light));
    check('with a greyed "for Dataverse" after the name, outside the name itself',
      /Data Model Designer <span class="guide-qualifier">for Dataverse<\/span>/.test(light), light.slice(0, 600));
    check('drawn from the 256px artwork rather than the 128px file',
      /img\/logo-256\.png/.test(light));
    // Above the progress bar, so it is the first thing on the first step rather than a badge
    // floating beside the steps.
    check('and it sits above the step bar',
      light.indexOf('guide-head') < light.indexOf('wizard-steps'));

    uiModule.closeModal();

    theme.setTheme('dark');
    sourcepickerModule.openSourcePicker({ mode: 'new' });

    const dark = modalText();

    check('the logo swaps with the theme',
      /img\/logo-dark-256\.png/.test(dark) && !/img\/logo-256\.png/.test(dark),
      (/img\/logo[^"]*/.exec(dark) || [''])[0]);

    uiModule.closeModal();
    theme.setTheme('light');

    // The About box lives in app.js, which this suite cannot import. The other half of "the same
    // lockup" is therefore read from its source: if it stopped building the head out of these four
    // classes the two screens would drift apart with nothing on either side to say so.
    const aboutSource = fsModule
      .readFileSync('../../src/Oliver4.DataModelDesigner/Web/js/app.js', 'utf8');
    const about = aboutSource.slice(aboutSource.indexOf('function showAbout('));

    check('the About box was found in app.js', about.includes('openModal('), about.length + ' chars');
    // The name line comes from util.productName, which is what draws guide-name and the greyed
    // "for Dataverse" after it, so the About box asks for that rather than the class directly.
    check('and it builds its head out of the same four classes',
      /guide-head/.test(about) && /guide-logo/.test(about) &&
      /brand-eyebrow/.test(about) && /productName\(/.test(about));
  }

  // =====================================================================
  console.log('\nA sticky note leans, by up to five degrees, and always the same way');
  // =====================================================================
  //
  // stickyTilt lives in geometry.js because annotationBounds needs it too, and render.js imports
  // geometry.js and never the reverse. The angle is derived from the note's own id rather than
  // stored, so a redraw must not change it, and it is large enough (up to five degrees) to read as
  // a deliberate slant rather than a rendering wobble.
  {
    check('stickyTilt is exported from geometry, where the bounds maths can reach it',
      typeof geometry.stickyTilt === 'function');

    const sample = Array.from({ length: 400 }, (unused, i) => geometry.stickyTilt({ id: 'tilt-' + i }));

    check('no note leans by more than five degrees',
      sample.every(t => Math.abs(t) <= 5), Math.max(...sample.map(Math.abs)) + ' degrees');
    check('and the lean reaches far enough to read as paper rather than as a wobble',
      Math.max(...sample.map(Math.abs)) >= 4.5, Math.max(...sample.map(Math.abs)) + ' degrees');
    check('notes lean both ways', sample.some(t => t > 2) && sample.some(t => t < -2));
    check('and not all by the same amount', new Set(sample).size > 20, new Set(sample).size + ' angles');

    freshDocument('Leaning notes');

    const note = state.newAnnotation('note', { x: 300, y: 300 });
    note.text = 'Design decision';
    state.state.doc.annotations = [note];

    const drawnAngle = () => {
      const match = /rotate\((-?[\d.]+),/.exec(annotationMarkup());
      return match ? match[1] : null;
    };

    render.render();
    const firstAngle = drawnAngle();
    render.render();

    check('the drawn paper keeps its angle across renders',
      firstAngle !== null && drawnAngle() === firstAngle, firstAngle + ' then ' + drawnAngle());
    check('and it is the angle geometry gives for that note, so there is one rule not two',
      firstAngle !== null && Number(firstAngle) === geometry.round(geometry.stickyTilt(note)),
      firstAngle + ' against ' + geometry.round(geometry.stickyTilt(note)));

    note.tilt = 1.5;
    render.render();

    check('an explicit tilt overrides the derived one', geometry.stickyTilt(note) === 1.5);
    check('and it is what gets drawn', drawnAngle() === '1.5', drawnAngle());

    note.tilt = 0;
    check('including a deliberate zero, so a note can be pinned straight',
      geometry.stickyTilt(note) === 0);

    delete note.tilt;
    check('and removing it hands the note back to its id',
      geometry.stickyTilt(note) === Number(firstAngle));
  }

  // =====================================================================
  console.log('\nA tilted note takes up more room than the box it was placed in');
  // =====================================================================
  //
  // annotationBounds is the rotated envelope: the box for anything asking what is on the canvas -
  // documentBounds, the marquee, Fit and therefore every export. annotationRect stays the placed
  // rectangle a resize drag is seeded from, and growing that by the tilt would make every resize
  // inflate the note a little more than the one before.
  {
    freshDocument('Envelopes');

    const note = { id: 'tilted-note', kind: 'note', x: 100, y: 100, width: 240, height: 96 };
    const rect = geometry.annotationRect(note);
    const bounds = geometry.annotationBounds(note);

    check('the fixture note is actually tilted',
      Math.abs(geometry.stickyTilt(note)) > 3, geometry.stickyTilt(note) + ' degrees');
    check('its envelope is wider than its rectangle',
      bounds.width > rect.width, bounds.width + ' against ' + rect.width);
    check('and taller', bounds.height > rect.height, bounds.height + ' against ' + rect.height);
    check('and it grows about the note centre rather than off one corner',
      Math.abs((bounds.x + bounds.width / 2) - (rect.x + rect.width / 2)) < 0.001 &&
      Math.abs((bounds.y + bounds.height / 2) - (rect.y + rect.height / 2)) < 0.001,
      JSON.stringify(bounds));

    check('the placed rectangle is left alone, so a resize cannot inflate the note',
      rect.x === 100 && rect.y === 100 && rect.width === 240 && rect.height === 96,
      JSON.stringify(rect));

    const identical = annotation =>
      JSON.stringify(geometry.annotationBounds(annotation)) ===
      JSON.stringify(geometry.annotationRect(annotation));

    check('a text box is not tilted, so its envelope is its rectangle',
      identical({ id: 'bounds-text', kind: 'text', x: 0, y: 0, width: 220, height: 40 }));
    check('nor is an arrow, whose rectangle is drawn from its own vector',
      identical({ id: 'bounds-arrow', kind: 'arrow', x: 400, y: 400, dx: -120, dy: -80 }));

    // Placed well clear of anything else on the canvas, so the drawing's edges are the note's and
    // the difference between the two answers is the tilt and nothing else.
    const far = Object.assign({}, note, { x: 5000, y: 5000 });

    state.state.doc.annotations = [far];
    const tiltedBox = geometry.documentBounds(0);

    state.state.doc.annotations = [Object.assign({}, far, { tilt: 0 })];
    const straightBox = geometry.documentBounds(0);

    check('the drawing is sized to the envelope, so a leaning corner cannot fall off an export',
      tiltedBox.width > straightBox.width && tiltedBox.height > straightBox.height,
      tiltedBox.width + 'x' + tiltedBox.height + ' against ' +
      straightBox.width + 'x' + straightBox.height);

    state.state.doc.annotations = [];
  }

  // =====================================================================
  console.log('\nThe asterisk against a mandatory column');
  // =====================================================================
  //
  // One rule for "is this row marked", in geometry, because the renderer draws it and the size
  // cache has to fold it into its digest. It is drawn inside the marker gutter the card already
  // reserves, so it costs no width at all - which is what keeps the measurer and the renderer from
  // being able to disagree about it.
  {
    const doc = freshDocument('Mandatory columns');

    const table = fixtureTable('t-required', 'account', 'Account', [
      { id: 'c-required', logicalName: 'cs_contractref', schemaName: 'cs_ContractRef',
        displayName: 'Contract reference', typeName: 'Text (100)', isPrimaryId: false,
        isPrimaryName: false, isLookup: false, isRequired: true, targets: [], selected: true,
        status: 'Existing' },
      { id: 'c-optional', logicalName: 'cs_nickname', schemaName: 'cs_Nickname',
        displayName: 'Nickname', typeName: 'Text (100)', isPrimaryId: false,
        isPrimaryName: false, isLookup: false, isRequired: false, targets: [], selected: true,
        status: 'Existing' }
    ]);

    doc.tables.push(table);
    doc.settings.fieldDetail = 'AllFields';
    geometry.invalidateSizes();

    const required = table.columns.find(c => c.id === 'c-required');
    const optional = table.columns.find(c => c.id === 'c-optional');

    check('geometry decides which rows are marked',
      geometry.hasRequiredMark(required) === true && geometry.hasRequiredMark(optional) === false);
    check('and says no to a column that carries no flag at all',
      geometry.hasRequiredMark({}) === false && geometry.hasRequiredMark(null) === false);

    render.render();

    const asterisks = layer => (layer.match(/>\*<\/text>/g) || []).length;

    check('the card draws exactly one asterisk, for the one mandatory column',
      asterisks(serialiseLayer('layer-tables')) === 1,
      asterisks(serialiseLayer('layer-tables')) + ' asterisks');

    // Costing no width is the point: nothing about the asterisk changes what the measurer has to
    // allow for, so measurer and renderer cannot drift apart over it.
    const withMark = geometry.measureTable(table);
    const markedSize = { width: withMark.width, height: withMark.height };

    required.isRequired = false;
    geometry.invalidateSizes();

    const withoutMark = geometry.measureTable(table);

    check('the card is measured to exactly the same size either way',
      withoutMark.width === markedSize.width && withoutMark.height === markedSize.height,
      withoutMark.width + 'x' + withoutMark.height + ' against ' +
      markedSize.width + 'x' + markedSize.height);

    render.render();
    check('and with the flag off the card draws no asterisk at all',
      asterisks(serialiseLayer('layer-tables')) === 0,
      asterisks(serialiseLayer('layer-tables')) + ' asterisks');

    required.isRequired = true;
    geometry.invalidateSizes();
    render.render();

    // Exports run the whole drawing through withLightPalette, so the asterisk has to come out of
    // the palette like everything else on the card rather than out of a literal.
    theme.setTheme('dark');
    geometry.invalidateSizes();
    render.render();

    const darkMark = theme.palette().requiredMark;

    check('on a dark canvas the asterisk is drawn in the dark red',
      serialiseLayer('layer-tables').includes('fill="' + darkMark + '"'), darkMark);

    const exported = render.buildExportSvg();

    theme.setTheme('light');
    geometry.invalidateSizes();

    const lightMark = theme.palette().requiredMark;

    check('an export taken from that canvas still carries the asterisk',
      asterisks(exported) === 1, asterisks(exported) + ' asterisks');
    check('and draws it in the light red, like everything else in an export',
      exported.includes('fill="' + lightMark + '"'), lightMark);
    check('rather than the dark one it was on screen',
      !exported.includes('fill="' + darkMark + '"'));

    // The size cache holds the rows it measured, and each row holds a reference to the column it
    // was measured from. Undo does not edit a column in place, it swaps in a clone of the whole
    // document - so a digest that ignored isRequired would serve the card from the cache and go on
    // drawing rows that point into the document that was undone.
    //
    // Reproduced by replacing the columns array without touching anything else the key is built
    // from: no mutate, so the topology counter - which empties the cache wholesale - does not move.
    render.render();
    geometry.measureTable(table);

    table.columns = table.columns.map(column => Object.assign({}, column, {
      isRequired: column.id === 'c-required' ? false : column.isRequired
    }));

    const remeasured = geometry.measureTable(table);
    const rowFor = remeasured.rows.find(row => row.column.id === 'c-required');

    check('flipping the flag on a cloned columns array misses the cache',
      !!rowFor && rowFor.column === table.columns.find(c => c.id === 'c-required'),
      rowFor ? 'row holds ' + (rowFor.column.isRequired ? 'the old column' : 'the new one') : 'no row');

    render.render();
    check('so the card stops drawing the asterisk it had been undone out of',
      asterisks(serialiseLayer('layer-tables')) === 0,
      asterisks(serialiseLayer('layer-tables')) + ' asterisks');
  }

  // =====================================================================
  console.log('\nA proposed relationship anchors at the lookup and at the primary key');
  // =====================================================================
  //
  // The one end of a proposed 1:N must not fall back to the middle of the card header in ordinary
  // cases. referencedAttribute is resolved from the table on every sync, and routeRelationship
  // takes a second try - the row the card itself calls its primary key - before it settles for the
  // header.
  //
  // The fallback is only a fallback. A named attribute that is drawn still wins, and a primary key
  // the user has taken off the card is not put back by it.
  {
    const rowCentre = (table, columnName) => {
      const size = geometry.measureTable(table);
      const index = size.rows.findIndex(row =>
        String((row.column || {}).logicalName || '').toLowerCase() === String(columnName).toLowerCase());

      return index < 0 ? null
        : table.y + geometry.METRICS.headerHeight +
          index * geometry.METRICS.rowHeight + geometry.METRICS.rowHeight / 2;
    };

    const headerCentre = table => table.y + geometry.METRICS.headerHeight / 2;

    /** A one-end card on the left and a many-end card on the right, so the route runs sideways. */
    const layOut = (one, many) => {
      one.x = 0; one.y = 0;
      many.x = 700; many.y = 0;
      geometry.invalidateSizes();
    };

    const anchor = relationship => geometry.routeRelationship(relationship, 0, 1);

    // ---- a proposed one end whose primary key is claimed by the column, not by the table

    {
      const doc = freshDocument('Column-claimed key');
      doc.settings.fieldDetail = 'AllFields';

      const one = fixtureTable('t-hub', 'cs_hub', 'Hub');
      const many = fixtureTable('t-spoke', 'cs_spoke', 'Spoke');

      // A table proposed on the canvas can claim a primary key on the column before the table-level
      // name has caught up: the two are written by different paths and a relationship can be
      // proposed between them in the meantime.
      one.status = 'Proposed';
      one.primaryIdAttribute = '';

      doc.tables.push(one, many);
      layOut(one, many);

      const link = {
        id: 'r-hub', schemaName: 'cs_hub_spoke', kind: 'OneToMany', status: 'Proposed',
        fromTableId: one.id, toTableId: many.id, referencingAttribute: '', referencedAttribute: '',
        included: true, hidden: false, highlight: null, waypoints: [], notes: ''
      };

      doc.relationships.push(link);
      state.syncProposedLookupColumn(link);
      geometry.invalidateSizes();

      check('the one end names its key from the column that claims it',
        link.referencedAttribute === 'cs_hubid', link.referencedAttribute);

      const route = anchor(link);

      check('so the connector lands on that row rather than on the card header',
        !!route && Math.abs(route.start.y - rowCentre(one, 'cs_hubid')) < 0.01,
        route && route.start.y + ' against ' + rowCentre(one, 'cs_hubid'));
      check('and the many end lands on the lookup column the proposal created',
        !!route && Math.abs(route.end.y - rowCentre(many, link.referencingAttribute)) < 0.01,
        route && route.end.y + ' against ' + rowCentre(many, link.referencingAttribute));
    }

    // ---- the one end swapped after referencedAttribute had already been written

    {
      const doc = freshDocument('Swapped one end');
      doc.settings.fieldDetail = 'AllFields';

      const account = fixtureTable('t-account', 'account', 'Account');
      const lead = fixtureTable('t-lead', 'lead', 'Lead');
      const many = fixtureTable('t-order', 'cs_order', 'Order');

      doc.tables.push(account, lead, many);
      layOut(account, many);
      lead.x = 0; lead.y = 0;

      const link = {
        id: 'r-swap', schemaName: 'cs_account_order', kind: 'OneToMany', status: 'Proposed',
        fromTableId: account.id, toTableId: many.id, referencingAttribute: '',
        referencedAttribute: '', included: true, hidden: false, highlight: null,
        waypoints: [], notes: ''
      };

      doc.relationships.push(link);
      state.syncProposedLookupColumn(link);

      check('the first one end writes its own key', link.referencedAttribute === 'accountid',
        link.referencedAttribute);

      // The user swaps the one end. The old name is a column the new card has never heard of.
      link.fromTableId = lead.id;
      state.syncProposedLookupColumn(link);
      geometry.invalidateSizes();

      check('swapping the one end re-derives the key rather than keeping the old table\'s',
        link.referencedAttribute === 'leadid', link.referencedAttribute);

      const route = anchor(link);

      check('so the connector follows it to the new card\'s key row',
        !!route && Math.abs(route.start.y - rowCentre(lead, 'leadid')) < 0.01,
        route && route.start.y + ' against ' + rowCentre(lead, 'leadid'));
    }

    // ---- a primary key named after the relationship was proposed, with nothing re-syncing

    {
      const doc = freshDocument('Late primary key');
      doc.settings.fieldDetail = 'AllFields';

      const one = fixtureTable('t-late', 'cs_late', 'Late');
      const many = fixtureTable('t-child', 'cs_child', 'Child');

      // Nothing on this card is a key yet, and the table names none either.
      one.status = 'Proposed';
      one.primaryIdAttribute = '';
      one.columns = [];

      doc.tables.push(one, many);
      layOut(one, many);

      const link = {
        id: 'r-late', schemaName: 'cs_late_child', kind: 'OneToMany', status: 'Proposed',
        fromTableId: one.id, toTableId: many.id, referencingAttribute: '', referencedAttribute: '',
        included: true, hidden: false, highlight: null, waypoints: [], notes: ''
      };

      doc.relationships.push(link);
      state.syncProposedLookupColumn(link);

      check('a one end with no key names none', !link.referencedAttribute,
        String(link.referencedAttribute));

      // The user names the key afterwards, in the table editor. Nothing touches the relationship,
      // so nothing re-derives its referenced attribute - the route has to find the row itself.
      one.columns.push({
        id: 'c-latekey', logicalName: 'cs_lateid', schemaName: 'cs_LateId', displayName: 'Identifier',
        typeName: 'Unique identifier', isPrimaryId: true, isPrimaryName: false, isLookup: false,
        targets: [], selected: true, status: 'Proposed'
      });

      geometry.invalidateSizes();

      const route = anchor(link);

      check('the relationship still names no referenced attribute', !link.referencedAttribute,
        String(link.referencedAttribute));
      check('and the connector finds the key row anyway rather than meeting the header',
        !!route && Math.abs(route.start.y - rowCentre(one, 'cs_lateid')) < 0.01,
        route && route.start.y + ' against ' + rowCentre(one, 'cs_lateid'));
    }

    // ---- what must still fall back to the header

    {
      const doc = freshDocument('Still the header');
      doc.settings.fieldDetail = 'AllFields';

      const one = fixtureTable('t-real', 'account', 'Account');
      const many = fixtureTable('t-real-many', 'contact', 'Contact', [
        { id: 'c-real-lookup', logicalName: 'parentcustomerid', schemaName: 'ParentCustomerId',
          displayName: 'Company', typeName: 'Lookup', isPrimaryId: false, isPrimaryName: false,
          isLookup: true, targets: ['account'], selected: true, status: 'Existing' }
      ]);

      doc.tables.push(one, many);
      layOut(one, many);

      // An existing relationship's referenced attribute comes from Dataverse and is already right.
      // If the column it names is not on the card, the card genuinely is not showing it, and the
      // header is the honest answer - guessing at the primary key would point at a different field.
      const existing = {
        id: 'r-existing', schemaName: 'contact_customer_accounts', kind: 'OneToMany',
        status: 'Existing', fromTableId: one.id, toTableId: many.id,
        referencedAttribute: 'cs_notonthiscard', referencingAttribute: 'parentcustomerid',
        included: true, hidden: false, highlight: null, waypoints: [], notes: ''
      };

      doc.relationships.push(existing);
      geometry.invalidateSizes();

      check('the one end does draw a primary key row to be tempted by',
        rowCentre(one, 'accountid') !== null);

      const existingRoute = anchor(existing);

      check('but an existing relationship whose referenced attribute is not drawn meets the header',
        !!existingRoute && Math.abs(existingRoute.start.y - headerCentre(one)) < 0.01,
        existingRoute && existingRoute.start.y + ' against ' + headerCentre(one));

      // A primary key the user has unticked in the inspector is not drawn at all, so there is no
      // row to land on. The fallback reads the rows that are there rather than the table's idea of
      // its key, which is what stops it putting back a row somebody has taken off the card.
      const proposed = {
        id: 'r-unticked', schemaName: 'cs_unticked', kind: 'OneToMany', status: 'Proposed',
        fromTableId: one.id, toTableId: many.id, referencingAttribute: '', referencedAttribute: '',
        included: true, hidden: false, highlight: null, waypoints: [], notes: ''
      };

      doc.relationships.push(proposed);
      state.syncProposedLookupColumn(proposed);

      one.columns.find(c => c.isPrimaryId).selected = false;
      geometry.invalidateSizes();

      check('the unticked key really is off the card', rowCentre(one, 'accountid') === null);

      const proposedRoute = anchor(proposed);

      check('so a proposal at that end meets the header too, rather than putting the row back',
        !!proposedRoute && Math.abs(proposedRoute.start.y - headerCentre(one)) < 0.01,
        proposedRoute && proposedRoute.start.y + ' against ' + headerCentre(one));
    }
  }

  // =====================================================================
  console.log('\nThe intended lookup column is mandatory on a proposed relationship');
  // =====================================================================
  //
  // A proposed 1:N *is* a lookup column plus its cascade rules, so the column has to have a name:
  // it is what the connector anchors to and what the proposed row on the many-end card is called.
  // The mandatory box opens on the derived name rather than empty, and goes on following the table
  // at the one end until the user takes it over.
  {
    /** The .field wrapper whose label starts with a given text. A required field carries a * too. */
    const fieldNamed = (root, label) => find(root, node =>
      node.classList && node.classList.contains('field') &&
      String(node.textContent).trim().startsWith(label));

    const controlIn = (wrapper, tagName) =>
      wrapper ? find(wrapper, node => node.tagName === tagName) : null;

    const errorText = () => findAll(modal(), node =>
      node.classList && node.classList.contains('form-error'))
      .map(node => String(node.textContent)).join(' ');

    const primaryButton = () => {
      const foot = find(modal(), node => node.classList && node.classList.contains('modal-foot'));
      return foot && find(foot, node => node.tagName === 'button' &&
        node.classList && node.classList.contains('primary'));
    };

    const doc = freshDocument('Mandatory lookup');
    const one = fixtureTable('t-one-end', 'account', 'Account');
    const many = fixtureTable('t-many-end', 'order', 'Order');

    doc.tables.push(one, many);
    geometry.invalidateSizes();

    proposedModule.openProposedRelationshipEditor({ fromTableId: one.id, toTableId: many.id });

    check('the proposed relationship editor opens', /Propose a relationship/.test(modalText()));

    const lookupField = () => fieldNamed(modal(), 'Intended lookup column');
    const lookupInput = controlIn(lookupField(), 'input');

    check('it offers an intended lookup column at all', !!lookupInput);
    check('marked as a mandatory box', /class="req"/.test(
      lookupField() ? new XMLSerializer().serializeToString(lookupField()) : ''));
    check('and it opens pre-filled with the name derived from the one end',
      !!lookupInput && lookupInput.value === 'accountid', lookupInput && lookupInput.value);
    check('with the primary button ready to use',
      !!primaryButton() && primaryButton().disabled !== true);

    // Swap sits between the two pickers. While the user has not typed in the box the name follows
    // the table at the one end, so swapping the ends renames it rather than leaving behind a name
    // derived from the table that is now at the other end.
    check('Swap is offered', clickByText(modal(), 'Swap'));

    check('and it re-derives the lookup name from the new one end',
      lookupInput.value === 'orderid', lookupInput.value);

    clickByText(modal(), 'Swap');
    check('swapping back derives it again', lookupInput.value === 'accountid', lookupInput.value);

    lookupInput.value = 'cs_customerid';
    fire(lookupInput, 'input');

    clickByText(modal(), 'Swap');
    check('once the user has typed in it, Swap leaves the name alone',
      lookupInput.value === 'cs_customerid', lookupInput.value);

    clickByText(modal(), 'Swap');

    lookupInput.value = '';
    fire(lookupInput, 'input');

    check('emptying it is refused, in a message that says what the column is for',
      /needs a name/.test(errorText()), errorText());
    check('the box itself is marked as an unfilled mandatory one',
      lookupInput.classList.contains('needs-value'));
    check('and the primary button is disabled while it is empty',
      !!primaryButton() && primaryButton().disabled === true);

    lookupInput.value = 'cs_customerid';
    fire(lookupInput, 'input');

    check('putting a name back clears the refusal', !/needs a name/.test(errorText()), errorText());
    check('and re-enables the primary button',
      !!primaryButton() && primaryButton().disabled !== true);

    // A many-to-many has an intersect table rather than a lookup, so the requirement cannot apply
    // to it - the field is taken away rather than left sitting there empty and mandatory.
    lookupInput.value = '';
    fire(lookupInput, 'input');

    const cardinality = controlIn(fieldNamed(modal(), 'Cardinality'), 'select');

    check('the cardinality picker is there', !!cardinality);

    pickOption(cardinality, 'ManyToMany');

    check('a many-to-many does not show the lookup column at all',
      !!lookupField() && lookupField().hidden === true,
      lookupField() ? String(lookupField().hidden) : 'no field');
    check('and does not require it either, so an empty box no longer blocks the dialog',
      !!primaryButton() && primaryButton().disabled !== true);
    check('with nothing left on screen complaining about it',
      !/needs a name/.test(errorText()), errorText());

    pickOption(cardinality, 'OneToMany');

    check('going back to one-to-many brings the box back',
      !!lookupField() && lookupField().hidden === false);
    check('and requires it again', !!primaryButton() && primaryButton().disabled === true);

    uiModule.closeModal();
  }

  // =====================================================================
  console.log('\nHide is the one visibility control');
  // =====================================================================
  //
  // `hidden` is the one visibility setting. `included` is still *read*, because a .dvmd file
  // written before tool 1.7.0 can carry included: false and it means what hidden means - but nothing
  // writes it except the constant true an older build needs to find there.
  {
    const doc = freshDocument('One visibility flag');

    const from = fixtureTable('t-vis-from', 'account', 'Account');
    const to = fixtureTable('t-vis-to', 'contact', 'Contact');

    doc.tables.push(from, to);

    const relationship = {
      id: 'r-vis', schemaName: 'contact_customer_accounts', displayName: 'contact_customer_accounts',
      kind: 'OneToMany', status: 'Existing', fromTableId: from.id, toTableId: to.id,
      referencedAttribute: 'accountid', referencingAttribute: 'parentcustomerid',
      included: true, hidden: false, highlight: null, waypoints: [], notes: ''
    };

    doc.relationships.push(relationship);
    geometry.invalidateSizes();

    state.selectOnly('relationships', relationship.id);
    inspectorModule.refreshInspector();

    const inspectorButtons = () => findAll(inspectorBody(), node => node.tagName === 'button')
      .map(node => String(node.textContent).trim());
    const inspectorTags = () => findAll(inspectorBody(), node =>
      node.classList && node.classList.contains('tag')).map(node => String(node.textContent).trim());

    check('the relationship inspector builds', inspectorButtons().length > 0,
      inspectorButtons().join(' | '));
    check('and offers no Include or Exclude control',
      !inspectorButtons().some(text => /includ|exclud/i.test(text)), inspectorButtons().join(' | '));
    check('while still offering the control that stayed',
      inspectorButtons().includes('Hide connector'), inspectorButtons().join(' | '));
    check('and its status tag reads Visible',
      inspectorTags().includes('Visible'), inspectorTags().join(' | '));

    relationship.hidden = true;
    inspectorModule.refreshInspector();

    check('a hidden connector reads Hidden', inspectorTags().includes('Hidden'),
      inspectorTags().join(' | '));
    check('and the button turns into the way back', inspectorButtons().includes('Show connector'),
      inspectorButtons().join(' | '));

    // The legacy flag, as a file written before tool 1.7.0 carries it. It is read here and nowhere
    // else decides anything, so a diagram saved by an older build still looks the way it was left.
    relationship.hidden = false;
    relationship.included = false;
    inspectorModule.refreshInspector();

    check('a relationship an older build excluded still reads Hidden',
      inspectorTags().includes('Hidden'), inspectorTags().join(' | '));

    relationship.included = true;
    state.clearSelection();
    inspectorModule.hideInspector();

    // ---- the relationships panel filters and labels on what is visible

    const second = {
      id: 'r-vis-2', schemaName: 'account_primary_contact', displayName: 'account_primary_contact',
      kind: 'OneToMany', status: 'Existing', fromTableId: to.id, toTableId: from.id,
      referencedAttribute: 'contactid', referencingAttribute: 'primarycontactid',
      included: true, hidden: true, highlight: null, waypoints: [], notes: ''
    };

    doc.relationships.push(second);
    panelsModule.showTab('relationships');

    const relationshipTab = () =>
      new XMLSerializer().serializeToString(document.getElementById('tab-relationships'));

    check('the visibility chip is about what is visible, not about what is included',
      /Visible only/.test(relationshipTab()) && !/Included only/.test(relationshipTab()),
      (/>[^<]*only</.exec(relationshipTab()) || [''])[0]);
    check('and the count is of the connectors that are actually drawn',
      /1 of 2 shown/.test(relationshipTab()), (/\d+ of \d+ shown/.exec(relationshipTab()) || [''])[0]);

    const tickFor = schemaName => {
      const row = find(document.getElementById('tab-relationships'), node =>
        node.classList && node.classList.contains('row') &&
        String(node.textContent).includes(schemaName));
      return row && find(row, node => node.classList && node.classList.contains('chk') &&
        (node.listeners.click || []).length);
    };

    const tick = tickFor('contact_customer_accounts');
    check('a row in the panel has a visibility tick', !!tick);

    clickNode(tick);

    check('and clicking it writes hidden', relationship.hidden === true);
    check('and leaves the legacy flag alone rather than writing a second one',
      relationship.included === true, String(relationship.included));

    // ---- nothing in Web/js writes `included` except the constant true

    const jsDirectory = '../../src/Oliver4.DataModelDesigner/Web/js/';
    const writes = [];

    for (const name of fsModule.readdirSync(jsDirectory).filter(file => file.endsWith('.js'))) {
      // Comments are stripped: these files mention the flag in comments, and a scan those comments
      // satisfy proves nothing.
      const source = fsModule.readFileSync(jsDirectory + name, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

      // A property write - `x.included =` or `included:` in an object - rather than every mention.
      // `const included = ...` is a local name in the source picker and says nothing about the flag.
      for (const match of source.matchAll(/(?:\.|[{,]\s*)included\b\s*(?::|=(?!=))\s*([A-Za-z0-9_$.!]+)/g)) {
        writes.push(name + ': ' + match[0].replace(/\s+/g, ' ').trim());
      }
    }

    check('there are writes of the flag to look at, so the scan is looking at something',
      writes.length >= 4, writes.length + ' writes');
    check('and every one of them writes the constant true, for the older build that reads it',
      writes.every(entry => /\btrue$/.test(entry)), writes.join(' | '));

    // ---- the canvas context menu, which lives in app.js and cannot be opened here

    const appCode = fsModule
      .readFileSync('../../src/Oliver4.DataModelDesigner/Web/js/app.js', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    const menu = appCode.slice(appCode.indexOf('function showCanvasMenu('),
      appCode.indexOf('\nfunction openEditorFor('));

    check('the canvas menu was found', menu.includes('showContextMenu('), menu.length + ' chars');
    check('and its connector item offers Show or Hide connector',
      /'Show connector'/.test(menu) && /'Hide connector'/.test(menu));
    check('and offers nothing about including or excluding',
      !/includ/i.test(menu) && !/exclud/i.test(menu),
      (/[^\n]*(includ|exclud)[^\n]*/i.exec(menu) || [''])[0].trim());

    const toggle = appCode.slice(appCode.indexOf('function toggleConnectorHidden('));

    check('and the command behind it writes hidden and nothing else',
      /relationship\.hidden\s*=\s*!\s*relationship\.hidden/.test(toggle) &&
      !/\.included\s*=/.test(toggle.slice(0, toggle.indexOf('\n}'))),
      toggle.slice(0, 400).replace(/\s+/g, ' '));
  }

  // =====================================================================
  console.log('\nThe wizard records the relationships nobody ticked as hidden');
  // =====================================================================
  //
  // They are still written to the file, so the user can change their mind later without rebuilding
  // the diagram. They arrive hidden rather than excluded, so they stay reachable through the
  // visibility control.
  {
    const wizardTables = [
      { logicalName: 'account', displayName: 'Account', schemaName: 'Account',
        isCustom: false, isActivity: false, isIntersect: false },
      { logicalName: 'contact', displayName: 'Contact', schemaName: 'Contact',
        isCustom: false, isActivity: false, isIntersect: false }
    ];

    const discovered = [relationshipDto('contact_customer_accounts', 'account', 'contact', 'parentcustomerid')];

    const runWizard = async bulkButton => {
      freshDocument('Wizard commit');
      sourcepickerModule.invalidateCatalogue();
      state.state.connection = { connected: true, organizationFriendlyName: 'Verify', host: 'verify' };

      bridge.host.listTables = async () => wizardTables;
      bridge.host.discoverRelationships = async () => discovered;
      bridge.host.loadTables = async () => ({
        tables: [
          tableDto('account', 'Account', []),
          tableDto('contact', 'Contact', [lookup('parentcustomerid', 'account')])
        ],
        unreadable: []
      });

      sourcepickerModule.openSourcePicker({ mode: 'new' });
      clickByText(modal(), 'Selected tables');
      await settle();

      clickByText(modal(), 'Next: relationships');
      await settle();

      clickByText(modal(), bulkButton);
      clickByText(modal(), 'Create diagram');
      await settle();
    };

    await runWizard('Include all');

    const drawn = state.state.doc.relationships[0];

    check('a ticked relationship reaches the diagram', !!drawn, state.state.doc.relationships.length + '');
    check('and is drawn', !!drawn && drawn.hidden === false, drawn && String(drawn.hidden));

    await runWizard('Include none');

    const kept = state.state.doc.relationships[0];

    check('an unticked one is still recorded rather than thrown away',
      !!kept, state.state.doc.relationships.length + ' relationships');
    check('and it arrives hidden, which is the state the one remaining control can undo',
      !!kept && kept.hidden === true, kept && String(kept.hidden));
    check('rather than excluded, which nothing left on screen could have put right',
      !!kept && kept.included === true, kept && String(kept.included));

    uiModule.closeModal();
    state.state.connection = { connected: false };
    sourcepickerModule.invalidateCatalogue();
  }

  // =====================================================================
  console.log('\nThe way back to the explorer settings is a control, not a caption');
  // =====================================================================
  //
  // The back control has a row of its own above the filter box, so it is not squeezed to the width
  // of its label and read as a caption. It stays in the fixed head rather than the scrolling list,
  // which is why this dialog is split into a settings screen and a results screen.
  {
    freshDocument('Explorer nav');

    const catalogue = [
      { logicalName: 'account', displayName: 'Account', schemaName: 'Account', isCustom: false },
      { logicalName: 'contact', displayName: 'Contact', schemaName: 'Contact', isCustom: false }
    ];

    const summary = name => Object.assign({ isActivity: false, isIntersect: false },
      catalogue.find(t => t.logicalName === name));

    sourcepickerModule.invalidateCatalogue();
    state.state.connection = { connected: true, organizationFriendlyName: 'Verify', host: 'verify' };

    bridge.host.listTables = async () => catalogue;
    bridge.host.exploreGraph = async () => ({
      message: '', filteredOut: 0,
      tables: [
        { summary: summary('account'), hops: 0, degree: 1, via: [] },
        { summary: summary('contact'), hops: 1, degree: 1, via: ['contact_customer_accounts'] }
      ]
    });

    explorerModule.openExplorer();
    await settle();
    clickByText(modal(), 'Explore');
    await settle();

    const back = find(modal(), node => node.tagName === 'button' &&
      String(node.textContent).includes('Change settings'));

    check('the results carry the way back to the settings', !!back);

    const navRow = back && back.closest('.results-nav');

    check('and it sits in a row of its own', !!navRow);
    check('with nothing else in that row to squeeze it',
      !!navRow && findAll(navRow, node => node.tagName === 'button' || node.tagName === 'input').length === 1,
      navRow ? findAll(navRow, node => node.tagName === 'button' || node.tagName === 'input')
        .map(n => n.tagName).join(',') : '');

    const toolsRow = find(modal(), node =>
      node.classList && node.classList.contains('results-tools'));

    check('the filter box is in the row below', !!toolsRow &&
      !!find(toolsRow, node => node.tagName === 'input' && node.getAttribute('type') === 'search'));

    const head = navRow && navRow.parentNode;

    check('and both rows share the results head', !!head && !!toolsRow && toolsRow.parentNode === head);
    check('with the way back above the filter',
      !!head && head.childNodes.indexOf(navRow) < head.childNodes.indexOf(toolsRow),
      head ? head.childNodes.indexOf(navRow) + ' against ' + head.childNodes.indexOf(toolsRow) : '');

    // The head is fixed and the result list beside it is what scrolls, so a long walk cannot take
    // the way back off the screen with it.
    check('the head does not scroll with the results', !!head && head.style.flex === '0 0 auto',
      head && String(head.style.flex));

    let scroller = back;
    while (scroller && !(scroller.style && scroller.style.overflow === 'auto')) scroller = scroller.parentNode;

    check('so nothing above the way back is a scrolling container',
      scroller === null, scroller && String(scroller.getAttribute('class')));

    uiModule.closeModal();
    state.state.connection = { connected: false };
    sourcepickerModule.invalidateCatalogue();
  }

  // =====================================================================
  console.log('\nA version that arrives late still gets printed');
  // =====================================================================
  //
  // The About box and the feature guide both describe behaviour that changes between releases, so
  // each must name the release. app.info is fetched once at boot, where it can fail; the line draws
  // from whatever is known and repaints when a second attempt settles, rather than settling on
  // "Version unavailable" for the session.
  {
    check('the version line is exported and can be built on its own',
      typeof uiModule.versionLine === 'function');

    check('a version already in hand is printed',
      uiModule.versionLine({ version: '1.7.0' }).textContent === 'Version 1.7.0',
      uiModule.versionLine({ version: '1.7.0' }).textContent);
    check('and with nothing known and nothing to wait for it says so',
      uiModule.versionLine(null, null).textContent === 'Version unavailable',
      uiModule.versionLine(null, null).textContent);

    let deliver = null;
    const pending = new Promise(resolve => { deliver = resolve; });
    const late = uiModule.versionLine(null, pending);

    check('while a retry is in flight it says it is looking rather than that it does not know',
      late.textContent === 'Checking version...', late.textContent);

    deliver({ toolName: 'Oliver4 Data Model Designer', version: '1.7.0' });
    await settle();

    check('and it fills the version in when the retry lands', late.textContent === 'Version 1.7.0',
      late.textContent);

    // Held with a handler of this suite's own as well. Without one, a break that drops the version
    // line's rejection handler would take the whole run down as an unhandled rejection instead of
    // failing the check below, which is the thing that says what went wrong.
    const refusing = Promise.reject(new Error('no host'));
    refusing.catch(() => {});

    const failed = uiModule.versionLine(null, refusing);
    await settle();

    check('a retry that fails settles rather than sitting on "Checking version..."',
      failed.textContent === 'Version unavailable', failed.textContent);

    dialogsModule.openFeatureGuide({ toolName: 'Oliver4 Data Model Designer' },
      Promise.resolve({ toolName: 'Oliver4 Data Model Designer', version: '1.7.0' }));
    await settle();

    check('the feature guide names the build once the retry has landed',
      /Version 1\.7\.0/.test(modalText()), (/Version[^<]*/.exec(modalText()) || [''])[0]);

    uiModule.closeModal();

    // The other half of this behaviour is in app.js: the retry itself, and the two dialogs that pass
    // it. app.js boots the app, so importing it here would run the whole boot sequence against a
    // DOM shim that has none of it - a source check is the honest alternative to no check at all.
    const appCode = fsModule
      .readFileSync('../../src/Oliver4.DataModelDesigner/Web/js/app.js', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    const start = appCode.indexOf('function appInfoRetry(');
    const retry = start < 0 ? '' : appCode.slice(start, appCode.indexOf('\n}', start));

    check('app.js has a second attempt at app.info', retry.includes('host.getAppInfo('),
      retry.length + ' chars');
    check('which is nothing to wait for once the version is already known',
      /if\s*\(\s*appInfo\s*\|\|\s*!isHosted\s*\)\s*return\s+null\s*;/.test(retry),
      retry.slice(0, 160).replace(/\s+/g, ' '));
    check('and is made once and shared, rather than once per opener',
      /if\s*\(\s*!appInfoRetryRequest\s*\)/.test(retry));
    check('and is cleared on failure, so the next opener tries again rather than inheriting it',
      /catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*appInfoRetryRequest\s*=\s*null\s*;/.test(retry),
      retry.slice(-200).replace(/\s+/g, ' '));

    check('the About box hands that retry to its version line',
      /versionLine\s*\(\s*info\s*,\s*retry\s*\)/.test(appCode));

    const guideCalls = (appCode.match(/openFeatureGuide\s*\(/g) || []).length;
    const guideCallsWithRetry = (appCode.match(/openFeatureGuide\s*\(\s*appInfo\s*,\s*appInfoRetry\(\)\s*\)/g) || []).length;

    check('and there are feature-guide openers to check', guideCalls >= 2, guideCalls + ' calls');
    check('every one of which hands it one too', guideCallsWithRetry === guideCalls,
      guideCallsWithRetry + ' of ' + guideCalls);
  }



  // =====================================================================
  console.log('\nThe derived lookup column keeps the publisher prefix intact');
  // =====================================================================
  //
  // The derived name keeps the underscore in the publisher prefix: a lookup to dev_project is
  // offered as "dev_projectid", not "devprojectid". The name is not a label - it goes onto the card
  // as the proposed column, it is what the connector anchors to, and it is what every export calls
  // the column.
  {
    check('a prefixed table derives a prefixed lookup name',
      state.lookupColumnName(null, { logicalName: 'dev_project' }) === 'dev_projectid',
      state.lookupColumnName(null, { logicalName: 'dev_project' }));
    check('and an unprefixed one is unchanged',
      state.lookupColumnName(null, { logicalName: 'account' }) === 'accountid',
      state.lookupColumnName(null, { logicalName: 'account' }));

    // The fallback source can be a display name, which is not a logical name at all: spaces and
    // punctuation still go, because Dataverse would not accept them either.
    check('a display name still loses its spaces and punctuation',
      state.lookupColumnName(null, { displayName: 'Case Type (draft)' }) === 'casetypedraftid',
      state.lookupColumnName(null, { displayName: 'Case Type (draft)' }));

    // The same sanitiser, one file over: proposed.js turns what the user typed into a logical name
    // for a hand-proposed column and into the default relationship schema name, so "dev_project_code"
    // must keep its underscores there too.
    check('a hand-proposed column keeps the underscore too',
      !/\[\^a-z0-9\]/.test(fsModule.readFileSync(
        '../../src/Oliver4.DataModelDesigner/Web/js/proposed.js', 'utf8')),
      (/[^\n]*\[\^a-z0-9\][^\n]*/.exec(fsModule.readFileSync(
        '../../src/Oliver4.DataModelDesigner/Web/js/proposed.js', 'utf8')) || ['none'])[0].trim());

    // Through the dialog, which is where the user actually meets the name.
    const doc = freshDocument('Prefixed lookup');
    const one = fixtureTable('t-pfx-one', 'dev_project', 'Project');
    const many = fixtureTable('t-pfx-many', 'dev_task', 'Task');

    doc.tables.push(one, many);
    geometry.invalidateSizes();

    proposedModule.openProposedRelationshipEditor({ fromTableId: one.id, toTableId: many.id });

    const lookupWrapper = find(modal(), node =>
      node.classList && node.classList.contains('field') &&
      String(node.textContent).trim().startsWith('Intended lookup column'));
    const lookupBox = lookupWrapper ? find(lookupWrapper, node => node.tagName === 'input') : null;

    check('the editor opens on the prefixed name',
      !!lookupBox && lookupBox.value === 'dev_projectid', lookupBox && lookupBox.value);

    uiModule.closeModal();

    // And the column the sync writes carries the same name, because the connector anchors to it
    // by name and a mismatch here puts the line on the card header instead of the row.
    const relationship = {
      id: 'r-pfx', schemaName: 'dev_project_tasks', displayName: 'dev_project_tasks',
      kind: 'OneToMany', status: 'Proposed', fromTableId: one.id, toTableId: many.id,
      referencedAttribute: '', referencingAttribute: '', included: true, hidden: false,
      highlight: null, waypoints: [], notes: ''
    };

    doc.relationships.push(relationship);
    state.syncProposedLookupColumn(relationship);

    check('and the proposed lookup column on the many end is called the same thing',
      (many.columns || []).some(column => column.logicalName === 'dev_projectid'),
      (many.columns || []).map(column => column.logicalName).join(', '));
  }

  // =====================================================================
  console.log('\nProposing a relationship starts from the table that is selected');
  // =====================================================================
  //
  // The one end defaults to the selected table, so the commonest way in - click the card you are
  // working on, then Propose a relationship - opens the dialog on that table and derives the lookup
  // name from it, rather than from the first table in the document.
  {
    const doc = freshDocument('Seed from the selection');

    const first = fixtureTable('t-seed-1', 'account', 'Account');
    const second = fixtureTable('t-seed-2', 'contact', 'Contact');
    const third = fixtureTable('t-seed-3', 'dev_project', 'Project');

    doc.tables.push(first, second, third);
    geometry.invalidateSizes();

    const endValue = label => {
      const wrapper = find(modal(), node =>
        node.classList && node.classList.contains('field') &&
        String(node.textContent).trim().startsWith(label));
      const control = wrapper ? find(wrapper, node => node.tagName === 'select') : null;
      return control ? control.value : null;
    };

    const lookupValue = () => {
      const wrapper = find(modal(), node =>
        node.classList && node.classList.contains('field') &&
        String(node.textContent).trim().startsWith('Intended lookup column'));
      const control = wrapper ? find(wrapper, node => node.tagName === 'input') : null;
      return control ? control.value : null;
    };

    state.clearSelection();
    proposedModule.openProposedRelationshipEditor();

    check('with nothing selected the one end is still the first table',
      endValue('From (the "one" end)') === first.id, endValue('From (the "one" end)'));

    uiModule.closeModal();

    state.selectOnly('tables', third.id);
    proposedModule.openProposedRelationshipEditor();

    check('with a table selected the one end is that table',
      endValue('From (the "one" end)') === third.id, endValue('From (the "one" end)'));
    check('and the many end is not the same table',
      endValue('To (the "many" end)') !== third.id, endValue('To (the "many" end)'));
    check('and the lookup name is derived from the selected table',
      lookupValue() === 'dev_projectid', lookupValue());

    uiModule.closeModal();

    // A seed from the caller knows more than the selection does: drag-to-connect names both ends,
    // and "propose a lookup on this table" names the many end and means it.
    state.selectOnly('tables', third.id);
    proposedModule.openProposedRelationshipEditor({ toTableId: third.id });

    check('a caller\'s own seed still wins over the selection',
      endValue('To (the "many" end)') === third.id, endValue('To (the "many" end)'));
    check('and the one end is not set to the same table',
      endValue('From (the "one" end)') !== third.id, endValue('From (the "one" end)'));

    uiModule.closeModal();

    // Five cards selected is not a choice of table. Picking one of them would be less predictable
    // than the first in the list, not more.
    state.clearSelection();
    state.toggleSelection('tables', second.id);
    state.toggleSelection('tables', third.id);
    proposedModule.openProposedRelationshipEditor();

    check('a multiple selection is not treated as a choice of table',
      endValue('From (the "one" end)') === first.id, endValue('From (the "one" end)'));

    uiModule.closeModal();
    state.clearSelection();
  }

  // =====================================================================
  console.log('\nAn annotation is drawn in front of the tables, or behind them');
  // =====================================================================
  //
  // There are two annotation layers, one either side of the tables, and each annotation says which
  // one it belongs in, so a sticky note can sit over a card and stay visible and clickable. In front
  // is the default, including for a file written before tool 1.9.0.
  //
  // Two real groups rather than one group re-sorted, because painting order is hit-test order: the
  // browser hands the pointer to the topmost painted element, so a note sent behind a card has to
  // actually be under the card in the document.
  {
    const doc = freshDocument('Annotation depth');

    doc.tables.push(fixtureTable('t-depth', 'account', 'Account'));
    geometry.invalidateSizes();

    const front = state.newAnnotation('note', { x: 40, y: 40 });
    const back = state.newAnnotation('note', { x: 240, y: 40 });

    front.text = 'In front';
    back.text = 'Behind';
    back.behind = true;

    doc.annotations.push(front, back);
    render.render();

    const behindLayer = new XMLSerializer()
      .serializeToString(document.getElementById('layer-annotations'));
    const frontLayer = new XMLSerializer()
      .serializeToString(document.getElementById('layer-annotations-front'));

    check('a new annotation is in front of the tables',
      state.annotationBehind(state.newAnnotation('note', { x: 0, y: 0 })) === false);

    // Written onto the annotation rather than left to the default, so the file says what the
    // drawing does and the two runtimes are not relying on agreeing about an absent property.
    check('and says so in the file rather than leaving it to be inferred',
      state.newAnnotation('note', { x: 0, y: 0 }).behind === false &&
      state.newAnnotation('text', { x: 0, y: 0 }).behind === false &&
      state.newAnnotation('arrow', { x: 0, y: 0 }).behind === false);
    check('and one drawn in front is rendered above the table layer',
      frontLayer.includes(front.id) && !behindLayer.includes(front.id));
    check('while one sent behind is rendered below it',
      behindLayer.includes(back.id) && !frontLayer.includes(back.id));

    // A file written before tool 1.9.0 has no such property on any of its annotations.
    check('an annotation from an older file is in front',
      state.annotationBehind({ id: 'a', kind: 'note' }) === false);

    // The export has to agree with the canvas, or the picture the user sends is not the drawing
    // they laid out. Checked by position in the file: an SVG is painted in document order.
    const exported = render.buildExportSvg();
    const firstTable = exported.indexOf('Account');

    check('the export draws a behind annotation before the tables',
      exported.indexOf('Behind') < firstTable && firstTable > 0,
      exported.indexOf('Behind') + ' against ' + firstTable);
    check('and a front annotation after them',
      exported.indexOf('In front') > firstTable,
      exported.indexOf('In front') + ' against ' + firstTable);

    // The inspector's control, and the same command on the annotation's right-click menu.
    state.selectOnly('annotations', front.id);
    inspectorModule.refreshInspector();

    const depthField = find(inspectorBody(), node =>
      node.classList && node.classList.contains('field') &&
      String(node.textContent).trim().startsWith('Depth'));
    const depthSelect = depthField ? find(depthField, node => node.tagName === 'select') : null;

    check('the annotation inspector offers the choice', !!depthSelect,
      String(inspectorBody().textContent).slice(0, 160));
    check('and opens on the side the annotation is actually on',
      !!depthSelect && depthSelect.value === 'front', depthSelect && depthSelect.value);

    pickOption(depthSelect, 'behind');

    check('choosing behind moves it', state.annotationBehind(front) === true);

    render.render();

    const movedBehind = new XMLSerializer()
      .serializeToString(document.getElementById('layer-annotations'));

    check('and the canvas redraws it on that side',
      movedBehind.includes(front.id), 'still in front');

    // An arrow is inspected through a different panel, and the context menu offers it the same depth
    // command - so it needs its own control, because the card takes every right-click where it covers
    // an arrow sent behind it.
    const arrow = state.newAnnotation('arrow', { x: 500, y: 500 });
    doc.annotations.push(arrow);

    state.selectOnly('annotations', arrow.id);
    inspectorModule.refreshInspector();

    const arrowDepth = find(inspectorBody(), node =>
      node.classList && node.classList.contains('field') &&
      String(node.textContent).trim().startsWith('Depth'));
    const arrowSelect = arrowDepth ? find(arrowDepth, node => node.tagName === 'select') : null;

    check('an arrow gets the same choice in its own panel', !!arrowSelect,
      String(inspectorBody().textContent).slice(0, 160));

    pickOption(arrowSelect, 'behind');
    check('and it can be sent behind from there', state.annotationBehind(arrow) === true);

    pickOption(arrowSelect, 'front');
    check('and brought back', state.annotationBehind(arrow) === false);

    state.clearSelection();
    inspectorModule.hideInspector();
  }

  // =====================================================================
  console.log('\nConnect mode still reaches a card with a note drawn over it');
  // =====================================================================
  //
  // Annotations are in front of the cards, and a note about a table is put on that table - so
  // "click the other table to draw the relationship to it" can land on the note. The connect branch
  // must resolve that click to the table underneath rather than selecting and dragging the note and
  // leaving the mode armed, as the same guard already does for the NOTE tag.
  {
    const doc = freshDocument('Connect through a note');

    const from = fixtureTable('t-conn-from', 'account', 'Account');
    const to = fixtureTable('t-conn-to', 'contact', 'Contact');

    from.x = 0; from.y = 0;
    to.x = 600; to.y = 0;

    doc.tables.push(from, to);

    const cover = state.newAnnotation('note', { x: to.x - 20, y: to.y - 20 });
    cover.text = 'Covers the card';
    doc.annotations.push(cover);

    geometry.invalidateSizes();

    const connected = [];

    interactions.initInteractions({
      onSelectionChange: () => {},
      onContextMenu: () => {},
      onOpenEditor: () => {},
      onConnect: (a, b) => { connected.push(a + ' -> ' + b); },
      onAnnotationPlaced: () => {}
    });

    render.render();

    const canvasNode = document.getElementById('canvas');

    // The note's own group, which is what the browser would hand the click to, since annotations are
    // painted above the cards.
    const noteNode = find(document.getElementById('layer-annotations-front'), node =>
      node.getAttribute && node.getAttribute('data-kind') === 'annotation');

    check('the covering note is drawn in front of the tables', !!noteNode);

    const inside = interactions.toScreen(to.x + 30, to.y + 20);

    interactions.startConnectMode(from.id);
    check('connect mode is armed', !!state.state.connect);

    // Dispatched to the distinct handlers: initInteractions has run more than once in this file, so
    // the canvas carries the same handler several times over and a browser would deliver once.
    for (const handler of new Set(canvasNode.listeners.pointerdown || [])) {
      handler({
        type: 'pointerdown', pointerId: 1, clientX: inside.x, clientY: inside.y, button: 0,
        shiftKey: false, ctrlKey: false, altKey: false, target: noteNode,
        preventDefault() {}, stopPropagation() {}
      });
    }

    check('clicking a note that covers the card still draws the relationship',
      connected.length === 1 && connected[0] === from.id + ' -> ' + to.id,
      connected.join(', ') || 'nothing connected');
    check('and connect mode is over',
      !state.state.connect, JSON.stringify(state.state.connect));
    check('and the note was not selected or picked up instead',
      !state.state.selection.annotations.has(cover.id));

    state.clearSelection();
  }

  // =====================================================================
  console.log('\nThe inspector sizes a note without reshaping it');
  // =====================================================================
  //
  // A sticky note resizes freely on each axis, so the inspector's box is a width only - the height is
  // the grip's job, and a control that changed the other side would be setting something the user
  // did not ask it to.
  {
    const doc = freshDocument('Note size in the inspector');

    const note = state.newAnnotation('note', { x: 60, y: 60 });
    doc.annotations.push(note);
    geometry.invalidateSizes();

    state.selectOnly('annotations', note.id);
    inspectorModule.refreshInspector();

    const widthField = find(inspectorBody(), node =>
      node.classList && node.classList.contains('field') &&
      String(node.textContent).trim().startsWith('Width'));

    check('the annotation inspector offers a width box for a note', !!widthField,
      String(inspectorBody().textContent).slice(0, 120));

    const widthSelect = widthField ? find(widthField, node => node.tagName === 'select') : null;

    check('which opens on the note\'s own width',
      !!widthSelect && widthSelect.value === '140', widthSelect && widthSelect.value);

    const noteHeight = note.height;

    pickOption(widthSelect, '260');

    check('and setting it leaves the height where the grip put it',
      note.width === 260 && note.height === noteHeight, note.width + 'x' + note.height);

    // The height is not offered as a box at all, so nothing here can claim to be one.
    check('and the panel offers no size control that sets both sides',
      !find(inspectorBody(), node =>
        node.classList && node.classList.contains('field') &&
        String(node.textContent).trim().startsWith('Size')));

    state.clearSelection();
    inspectorModule.hideInspector();
  }

  // =====================================================================
  console.log('\nThe legend can be dragged, and can always be got back');
  // =====================================================================
  //
  // The legend starts in the bottom-right corner and can be dragged elsewhere - it is the one piece
  // of furniture with no other place to go, because the zoom pill and the title block have the other
  // two corners.
  //
  // The position is stored in the diagram, so it is read back on machines with different screens.
  // The clamp is what stops that being a trap, and it is pure so it can be pinned here.
  {
    const clamp = uiModule.clampToViewport;
    const size = { width: 160, height: 120 };
    const viewport = { width: 1400, height: 900 };

    check('a point inside the window is left alone',
      clamp(500, 400, size, viewport, { top: 84 }).x === 500 &&
      clamp(500, 400, size, viewport, { top: 84 }).y === 400);

    check('a legend dragged off the right edge is pulled back onto the screen',
      clamp(1390, 400, size, viewport, { top: 84 }).x === 1400 - 160 - 8,
      String(clamp(1390, 400, size, viewport, { top: 84 }).x));

    check('and one dragged off the bottom too',
      clamp(500, 890, size, viewport, { top: 84 }).y === 900 - 120 - 8,
      String(clamp(500, 890, size, viewport, { top: 84 }).y));

    // The command bar floats over the canvas. Without the top inset the legend can be parked
    // underneath it, showing an edge and nothing to grab.
    check('the top inset keeps it clear of the command bar',
      clamp(500, 0, size, viewport, { top: 84 }).y === 84,
      String(clamp(500, 0, size, viewport, { top: 84 }).y));

    // A window smaller than the legend cannot satisfy both edges. The near edge wins, because the
    // far one is off screen either way and the near one is where the pointer can reach it.
    check('a window narrower than the legend keeps the near edge reachable',
      clamp(400, 400, size, { width: 100, height: 90 }, { top: 84 }).x === 8,
      String(clamp(400, 400, size, { width: 100, height: 90 }, { top: 84 }).x));

    // A hand-edited file, or a half-written pair. Neither may be read as a position.
    check('a position that is not a number falls back to the near edge',
      clamp('nonsense', undefined, size, viewport, { top: 84 }).x === 8 &&
      clamp('nonsense', undefined, size, viewport, { top: 84 }).y === 84);

    check('a new diagram has no legend position, which means the default corner',
      state.defaultSettings().legendX === null && state.defaultSettings().legendY === null,
      JSON.stringify([state.defaultSettings().legendX, state.defaultSettings().legendY]));

    // null is not a position, but Number(null) is 0 and 0 is finite - so a guard written as
    // Number.isFinite(Number(settings.legendX)) would read "never dragged" as "dragged to the
    // top-left", and every new diagram carries an explicit null. The legend would then be drawn over
    // the left panel on an untouched canvas, and Reset position would put it back there.
    check('an unplaced legend has no position at all',
      uiModule.furniturePosition(null, null) === null,
      JSON.stringify(uiModule.furniturePosition(null, null)));
    check('and neither does one written half way, or by hand',
      uiModule.furniturePosition(300, null) === null &&
      uiModule.furniturePosition(undefined, undefined) === null &&
      uiModule.furniturePosition('300', '200') === null &&
      uiModule.furniturePosition(NaN, NaN) === null);
    check('while the top-left corner really is a position',
      JSON.stringify(uiModule.furniturePosition(0, 0)) === '{"x":0,"y":0}',
      JSON.stringify(uiModule.furniturePosition(0, 0)));

    // A legend the user has dragged is a screen position, and nothing that leaves the tool is in
    // screen coordinates - so the export puts the legend back in a corner. Said in the preflight,
    // because the reason to move it is that it was on top of the cards.
    const exporterModule = await import(js + 'exporter.js');
    const doc = freshDocument('Exported legend');

    doc.tables.push(fixtureTable('t-legend', 'account', 'Account'));
    doc.settings.showLegend = true;
    geometry.invalidateSizes();

    uiModule.closeModal();
    exporterModule.openExportDialog();
    clickByText(modal(), 'PNG');

    check('a legend left in its corner says nothing about being moved',
      !/dragged the legend/.test(modalText()));

    uiModule.closeModal();

    doc.settings.legendX = 200;
    doc.settings.legendY = 200;

    exporterModule.openExportDialog();
    clickByText(modal(), 'PNG');

    check('a dragged legend is called out before a filename is chosen',
      /dragged the legend/.test(modalText()),
      modalText().slice(0, 200));

    uiModule.closeModal();

    doc.settings.legendX = null;
    doc.settings.legendY = null;

    // The way back from a drag, and from a hide, for someone who does not think to right-click the
    // legend - and for anyone using the keyboard, since the legend cannot take focus at all.
    dialogsModule.openDisplaySettings();

    check('Display settings says the legend can be moved',
      /dragged anywhere on the canvas/.test(modalText()));
    check('and offers no reset while it is still in its corner',
      !/Reset legend position/.test(modalText()));

    uiModule.closeModal();

    doc.settings.legendX = 260;
    doc.settings.legendY = 180;

    dialogsModule.openDisplaySettings();

    check('a moved legend gets a reset button in Display settings',
      /Reset legend position/.test(modalText()));

    clickByText(modal(), 'Reset legend position');

    check('and pressing it puts the legend back in the corner',
      doc.settings.legendX === null && doc.settings.legendY === null,
      doc.settings.legendX + ',' + doc.settings.legendY);

    uiModule.closeModal();

    // A blanket body.theme-dark rule can out-specify a state style, leaving the state dead in dark mode
    // only. This checks the legend's drag state survives in dark mode.
    const css = fsModule.readFileSync(
      '../../src/Oliver4.DataModelDesigner/Web/css/app.css', 'utf8');

    check('the legend has a picked-up state',
      /\.legend\.is-dragging\s*\{[^}]*box-shadow/.test(css));
    check('and dark mode does not swallow it',
      /body\.theme-dark \.legend\.is-dragging\s*\{[^}]*box-shadow/.test(css));
    check('and the rows do not keep their own cursor while the legend is being dragged',
      /\.legend\.is-dragging \.legend-named\s*\{[^}]*cursor/.test(css));
    check('and a touch drag is not handed to the browser as a pan',
      /\.legend\s*\{[^}]*touch-action:\s*none/.test(css));
  }

  // =====================================================================
  console.log('\nBehind means behind the connectors too, and notes go under labels');
  // =====================================================================
  //
  // The behind layer is below the connectors as well as the cards, so an annotation sent behind is
  // not drawn across the relationship lines running under it - which is also where both picture
  // exporters put it.
  //
  // Within one layer a sticky note is painted before a text box or an arrow, because a note is
  // opaque paper and a label lying on one has to stay readable.
  {
    const doc = freshDocument('Depth against the model');

    const one = fixtureTable('t-depth-one', 'account', 'Account');
    const many = fixtureTable('t-depth-many', 'contact', 'Contact');

    one.x = 0; one.y = 0;
    many.x = 600; many.y = 0;
    doc.tables.push(one, many);

    doc.relationships.push({
      id: 'r-depth', schemaName: 'contact_customer_accounts', kind: 'OneToMany',
      status: 'Existing', fromTableId: one.id, toTableId: many.id,
      referencingAttribute: 'accountid', included: true, hidden: false,
      waypoints: [], lookupTargets: []
    });

    geometry.invalidateSizes();

    const under = state.newAnnotation('note', { x: 200, y: 20 });
    const paper = state.newAnnotation('note', { x: 200, y: 300 });
    const label = state.newAnnotation('text', { x: 210, y: 310 });

    under.text = 'Under the model';
    under.behind = true;
    paper.text = 'Paper';
    label.text = 'Label on the paper';

    // Deliberately the wrong way round in the document: the text box is listed first, and the
    // renderer has to paint it last anyway.
    doc.annotations.push(label, paper, under);
    render.render();

    // Painting order is the order the groups are declared in index.html, and nothing re-sorts them
    // at run time - so that file is the whole of the rule and is what this reads. It cannot be
    // driven through the DOM shim, whose getElementById hands back a detached node per id rather
    // than a tree parsed from the page.
    const viewportOrder = (await import('node:fs'))
      .readFileSync('../../src/Oliver4.DataModelDesigner/Web/index.html', 'utf8');

    const layerOrder = Array.from(viewportOrder.matchAll(/<g id="(layer-[^"]+)"/g)).map(m => m[1]);

    check('the behind annotation layer is below the connectors as well as below the cards',
      layerOrder.indexOf('layer-annotations') >= 0 &&
      layerOrder.indexOf('layer-annotations') < layerOrder.indexOf('layer-links') &&
      layerOrder.indexOf('layer-links') < layerOrder.indexOf('layer-tables') &&
      layerOrder.indexOf('layer-tables') < layerOrder.indexOf('layer-annotations-front'),
      layerOrder.join(' > '));

    // Within a layer: notes first. Read off the rendered layer rather than off the array, because
    // what is being pinned is what the browser paints.
    const frontIds = Array.from(document.getElementById('layer-annotations-front').childNodes)
      .map(node => node.getAttribute && node.getAttribute('data-id'))
      .filter(Boolean);

    check('a sticky note is painted before a text box on the same side',
      frontIds.indexOf(paper.id) >= 0 && frontIds.indexOf(paper.id) < frontIds.indexOf(label.id),
      frontIds.join(', '));
    check('and the order the document happens to list them in does not decide it',
      doc.annotations.indexOf(label) < doc.annotations.indexOf(paper));

    // Two notes keep their document order, so "the last one placed sits on top" still holds.
    const second = state.newAnnotation('note', { x: 240, y: 340 });
    second.text = 'Placed later';
    doc.annotations.push(second);
    render.render();

    const withTwo = Array.from(document.getElementById('layer-annotations-front').childNodes)
      .map(node => node.getAttribute && node.getAttribute('data-id'))
      .filter(Boolean);

    check('and two notes keep the order they were placed in',
      withTwo.indexOf(paper.id) < withTwo.indexOf(second.id), withTwo.join(', '));

    check('the paint order is a pure function anything can ask for',
      state.annotationPaintOrder([label, paper]).map(a => a.id).join(',') ===
        paper.id + ',' + label.id);

    // The export builds the same stack by hand, and an SVG is painted in document order - so this
    // is a check about position in the file. The connector's own group is what the behind note has
    // to come before.
    const exported = render.buildExportSvg();
    const firstLink = exported.indexOf('stroke-linejoin');
    const behindAt = exported.indexOf('Under the model');
    const paperAt = exported.indexOf('Paper');
    const labelAt = exported.indexOf('Label on the paper');

    check('the export draws a behind annotation before the connectors',
      behindAt >= 0 && firstLink > 0 && behindAt < firstLink,
      behindAt + ' against ' + firstLink);
    check('and paints a note before a label on the same side',
      paperAt >= 0 && labelAt > paperAt, paperAt + ' against ' + labelAt);

    state.clearSelection();
  }

  // =====================================================================
  console.log('\nA sticky note can be turned');
  // =====================================================================
  //
  // The slant a note is drawn with is derived from its own id - stable across renders and saves.
  // The handle above a selected note lets the user set it, and an explicit angle then wins. Zero is
  // one of the answers it has to be able to give: a note squared to the page by hand must not have
  // the derived slant put back on it.
  {
    const doc = freshDocument('Turning a note');

    const note = state.newAnnotation('note', { x: 100, y: 100 });
    note.width = 160;
    note.height = 160;

    // A fixed id. The derived slant is a hash of it and `uid` is random, so a random id would make
    // every check below that depends on the note *having* a slant flaky. Picked so the slant is
    // neither zero nor a whole number of degrees, which is what an untouched note really looks like.
    note.id = 'n-slanted-fixture';

    doc.annotations.push(note);
    geometry.invalidateSizes();

    check('a note nobody has touched has a slant of its own',
      geometry.stickyTilt(note) !== 0 && Math.abs(geometry.stickyTilt(note)) <= 5,
      String(geometry.stickyTilt(note)));
    check('and gives the same answer every time it is asked',
      geometry.stickyTilt(note) === geometry.stickyTilt({ id: note.id, kind: 'note' }),
      String(geometry.stickyTilt(note)));

    note.tilt = 0;
    check('and a note straightened by hand stays straight',
      geometry.stickyTilt(note) === 0, String(geometry.stickyTilt(note)));

    delete note.tilt;

    // The handle itself. Gated on the selection like the resize grip, for the same reason: an
    // invisible control over every note would turn a drag meant to move one into a rotation.
    state.clearSelection();
    render.render();

    const knobWhenIdle = find(document.getElementById('layer-annotations-front'), node =>
      node.getAttribute && node.getAttribute('data-rotate'));

    check('an unselected note has no rotation handle', !knobWhenIdle);

    state.selectOnly('annotations', note.id);
    render.render();

    const knob = find(document.getElementById('layer-annotations-front'), node =>
      node.getAttribute && node.getAttribute('data-rotate'));

    check('a selected one does', !!knob);
    check('and it is left out of exports, like every other handle',
      !render.buildExportSvg().includes('data-rotate'));

    const textBox = state.newAnnotation('text', { x: 500, y: 500 });
    doc.annotations.push(textBox);
    state.selectOnly('annotations', textBox.id);
    render.render();

    check('a text box has no rotation handle - words at an angle are just harder to read',
      !find(document.getElementById('layer-annotations-front'), node =>
        node.getAttribute && node.getAttribute('data-rotate')));

    state.selectOnly('annotations', note.id);
    render.render();

    // ---- the drag itself
    //
    // The note is 160 square at 100,100, so it turns about world 180,180. The knob is grabbed from
    // straight above that centre and dragged to straight right of it, which is a quarter turn
    // clockwise however the pointer got there.
    const canvasNode = document.getElementById('canvas');
    const knobNode = find(document.getElementById('layer-annotations-front'), node =>
      node.getAttribute && node.getAttribute('data-rotate'));

    const above = interactions.toScreen(180, 60);
    const right = interactions.toScreen(300, 180);

    const send = (type, at, target, options) => {
      for (const handler of new Set(canvasNode.listeners[type] || [])) {
        handler(Object.assign({
          type, pointerId: 1, clientX: at.x, clientY: at.y, button: 0,
          shiftKey: false, ctrlKey: false, altKey: false,
          target: target || { closest: () => null, tagName: 'svg' },
          preventDefault() {}, stopPropagation() {}
        }, options || {}));
      }
    };

    note.tilt = 0;
    render.render();

    send('pointerdown', above, knobNode);
    send('pointermove', right);
    send('pointerup', right);

    check('dragging the handle a quarter turn turns the note a quarter turn',
      note.tilt === 90, String(note.tilt));

    // Undo swaps in a *clone* of the document, so everything after one has to re-resolve by id. A
    // local reference taken before the undo is a dead object that still answers questions.
    const live = () => state.state.doc.annotations.find(a => a.id === note.id);

    check('and the turn is one undoable step',
      state.canUndo() && state.undo() !== false && live().tilt === 0, String(live().tilt));

    // A note that has never been turned must not have its derived slant frozen into the file by a
    // drag that is then undone. Undo puts back what was there, and what was there was nothing.
    delete live().tilt;
    state.selectOnly('annotations', note.id);
    render.render();

    const knobAgain = find(document.getElementById('layer-annotations-front'), node =>
      node.getAttribute && node.getAttribute('data-rotate'));

    check('the handle is still there after the undo', !!knobAgain);

    send('pointerdown', above, knobAgain);
    send('pointermove', right);
    send('pointerup', right);

    // A quarter turn *from where it was standing*, which for an untouched note is its derived
    // slant of up to five degrees - not from upright. Grabbing the handle must not straighten the
    // note before the drag has moved anywhere; that would be a jump the user did not ask for.
    check('the second drag turns it a quarter turn from the slant it was already at',
      typeof live().tilt === 'number' && live().tilt !== 90 &&
      Math.abs(live().tilt - 90) <= 5, String(live().tilt));

    state.undo();

    check('undoing the first turn of an untouched note leaves it with no angle of its own',
      typeof live().tilt !== 'number', JSON.stringify(live().tilt));

    // Angles wrap. A drag that crosses the point where atan2 flips from 180 to -180 produces a
    // delta of nearly a full turn, and without folding it the note spins the long way round.
    check('an angle is folded back into a half turn either way',
      interactions.wrapDegrees(370) === 10 && interactions.wrapDegrees(-370) === -10 &&
      interactions.wrapDegrees(0) === 0,
      [interactions.wrapDegrees(370), interactions.wrapDegrees(-370)].join(', '));

    // The envelope. It is built from the magnitudes of the sine and cosine, not their signs: past
    // a quarter turn a signed cosine subtracts one side from the other and hands back a box
    // narrower than the note, which Fit and every picture export would then cut the note off in.
    const turned = state.newAnnotation('note', { x: 0, y: 0 });
    turned.width = 200;
    turned.height = 100;
    turned.tilt = 135;

    const bounds = geometry.annotationBounds(turned);

    check('a note turned past a quarter turn still measures at least its own size',
      bounds.width >= 200 && bounds.height >= 100,
      Math.round(bounds.width) + 'x' + Math.round(bounds.height));

    // ---- a dialog opening mid-drag abandons the rotation rather than half-committing it
    //
    // A modal covers the canvas, so any gesture waiting on that canvas is over. Ending it must put
    // back whatever the live drag had already written on the object, rather than leaving it with no
    // undo entry and the diagram not marked dirty - for a rotation, a note never turned would
    // otherwise carry the derived slant as an explicit angle, which the draw.io export treats as
    // chosen.
    delete live().tilt;
    state.selectOnly('annotations', note.id);
    render.render();
    state.setDirty(false);

    const knobBeforeDialog = find(document.getElementById('layer-annotations-front'), node =>
      node.getAttribute && node.getAttribute('data-rotate'));

    send('pointerdown', above, knobBeforeDialog);
    send('pointermove', right);

    check('the drag really is in flight before the dialog opens',
      live().tilt !== undefined, JSON.stringify(live().tilt));

    window.dispatchEvent(new CustomEvent('dmd:modal-opened'));
    send('pointerup', right);

    check('a dialog opening mid-rotation leaves the note with the angle it had - none',
      typeof live().tilt !== 'number', JSON.stringify(live().tilt));
    check('and does not mark the diagram dirty behind the dialog',
      state.state.dirty === false, String(state.state.dirty));

    // ---- the panel beside the canvas is told when a drag has changed what it is showing
    let redraws = 0;
    const countRedraw = () => { redraws++; };
    window.addEventListener('dmd:refresh-inspector', countRedraw);

    state.selectOnly('annotations', note.id);
    render.render();

    const knobForRedraw = find(document.getElementById('layer-annotations-front'), node =>
      node.getAttribute && node.getAttribute('data-rotate'));

    send('pointerdown', above, knobForRedraw);
    send('pointermove', right);
    send('pointerup', right);

    window.removeEventListener('dmd:refresh-inspector', countRedraw);

    check('a rotate drag asks the inspector to redraw itself', redraws > 0, redraws + ' redraws');

    // ---- resizing a turned note
    //
    // width and height are lengths along the note's own axes, and the grip is drawn inside the
    // rotation, so screen travel must be rotated into the note's frame before it is applied.
    // Measured in screen coordinates, on the corner as it is actually drawn, which is the only thing
    // the user can see.
    const drawnCorner = (annotation, sx, sy) => {
      const rect = geometry.annotationRect(annotation);
      const radians = geometry.stickyTilt(annotation) * Math.PI / 180;
      const vx = sx * rect.width / 2;
      const vy = sy * rect.height / 2;

      return interactions.toScreen(
        rect.x + rect.width / 2 + vx * Math.cos(radians) - vy * Math.sin(radians),
        rect.y + rect.height / 2 + vx * Math.sin(radians) + vy * Math.cos(radians));
    };

    for (const angle of [40, 180]) {
      const turned = state.newAnnotation('note', { x: 400, y: 400 });
      turned.width = 200;
      turned.height = 120;
      turned.tilt = angle;

      // state.state.doc, not the `doc` this section started with: there have been undos above, and
      // an undo swaps in a clone - pushing onto the old object would add a note to a document that is
      // no longer the one on screen.
      state.state.doc.annotations.push(turned);

      state.selectOnly('annotations', turned.id);
      geometry.invalidateSizes();
      render.render();

      const grip = find(document.getElementById('layer-annotations-front'), node =>
        node.getAttribute && node.getAttribute('data-resize') &&
        node.getAttribute('data-id') === turned.id);

      const held = drawnCorner(turned, 1, 1);
      const fixed = drawnCorner(turned, -1, -1);
      const target = { x: held.x + 60, y: held.y + 40 };

      // Ctrl is the fine-adjustment escape hatch, so the answer is snapped to one unit rather than
      // to eight - otherwise the tolerance below would have to be wider than the thing it measures.
      send('pointerdown', held, grip);
      send('pointermove', target, null, { ctrlKey: true });
      send('pointerup', target, null, { ctrlKey: true });

      const movedTo = drawnCorner(turned, 1, 1);
      const opposite = drawnCorner(turned, -1, -1);

      check('the grip of a note turned ' + angle + ' degrees follows the pointer',
        Math.abs(movedTo.x - target.x) <= 2 && Math.abs(movedTo.y - target.y) <= 2,
        Math.round(movedTo.x) + ',' + Math.round(movedTo.y) +
        ' against ' + Math.round(target.x) + ',' + Math.round(target.y));
      check('and the far corner stays where it was',
        Math.abs(opposite.x - fixed.x) <= 2 && Math.abs(opposite.y - fixed.y) <= 2,
        Math.round(opposite.x) + ',' + Math.round(opposite.y) +
        ' against ' + Math.round(fixed.x) + ',' + Math.round(fixed.y));
      check('and the note really did change size',
        turned.width !== 200 || turned.height !== 120,
        turned.width + 'x' + turned.height);
    }

    // ---- the same three questions of a resize, which writes position as well as size
    {
      const turned = state.newAnnotation('note', { x: 800, y: 100 });
      turned.width = 200;
      turned.height = 120;
      turned.tilt = 30;
      state.state.doc.annotations.push(turned);

      state.selectOnly('annotations', turned.id);
      geometry.invalidateSizes();
      render.render();
      state.setDirty(false);

      const before = { x: turned.x, y: turned.y, width: turned.width, height: turned.height };

      const grip = find(document.getElementById('layer-annotations-front'), node =>
        node.getAttribute && node.getAttribute('data-resize') &&
        node.getAttribute('data-id') === turned.id);

      const held = drawnCorner(turned, 1, 1);

      let redrawn = 0;
      const countRedraw = () => { redrawn++; };
      window.addEventListener('dmd:refresh-inspector', countRedraw);

      send('pointerdown', held, grip);
      send('pointermove', { x: held.x + 80, y: held.y + 40 });
      send('pointerup', { x: held.x + 80, y: held.y + 40 });

      window.removeEventListener('dmd:refresh-inspector', countRedraw);

      check('a resize drag asks the inspector to redraw itself too', redrawn > 0,
        redrawn + ' redraws');

      const after = { x: turned.x, y: turned.y, width: turned.width, height: turned.height };

      check('resizing a turned note moves it as well as growing it',
        after.width !== before.width && (after.x !== before.x || after.y !== before.y),
        JSON.stringify(after));

      state.undo();

      const restored = state.state.doc.annotations.find(a => a.id === turned.id);

      // Position as well as size. The commit takes its undo snapshot by putting the note back and then
      // re-applying, so x and y must be in that snapshot or an undone resize keeps the original size at
      // the dragged position.
      check('and undo puts back where it was as well as how big it was',
        restored.width === before.width && restored.height === before.height &&
        Math.abs(restored.x - before.x) < 0.001 && Math.abs(restored.y - before.y) < 0.001,
        JSON.stringify({ x: restored.x, y: restored.y, w: restored.width, h: restored.height }));

      // And the same abandonment the rotation gets, for the mode that writes four properties.
      state.setDirty(false);
      render.render();

      const gripAgain = find(document.getElementById('layer-annotations-front'), node =>
        node.getAttribute && node.getAttribute('data-resize') &&
        node.getAttribute('data-id') === restored.id);

      send('pointerdown', held, gripAgain);
      send('pointermove', { x: held.x + 80, y: held.y + 40 });

      window.dispatchEvent(new CustomEvent('dmd:modal-opened'));
      send('pointerup', { x: held.x + 80, y: held.y + 40 });

      const abandoned = state.state.doc.annotations.find(a => a.id === turned.id);

      check('a dialog opening mid-resize puts the note back the size and place it was',
        abandoned.width === before.width && abandoned.height === before.height &&
        Math.abs(abandoned.x - before.x) < 0.001 && Math.abs(abandoned.y - before.y) < 0.001,
        JSON.stringify({ x: abandoned.x, y: abandoned.y, w: abandoned.width, h: abandoned.height }));
      check('and leaves the diagram no dirtier than it found it',
        state.state.dirty === false, String(state.state.dirty));
    }

    // ---- what a drag paints outside the document, and what happens to a drag whose document goes
    {
      // A marquee is a sibling of the whole viewport rather than something inside a layer, so no
      // redraw clears it: an abandoned marquee must be removed explicitly, or it stays painted across
      // the canvas. The pan cursor is the same shape of problem.
      state.clearSelection();
      render.render();

      send('pointerdown', { x: 240, y: 240 });
      send('pointermove', { x: 420, y: 380 });

      const marquee = document.getElementById('marquee');

      check('a marquee drag paints a rectangle', marquee.style.display !== 'none',
        String(marquee.style.display));

      window.dispatchEvent(new CustomEvent('dmd:modal-opened'));
      send('pointerup', { x: 420, y: 380 });

      check('and a dialog opening over it takes the rectangle away',
        marquee.style.display === 'none', String(marquee.style.display));

      const canvasEl = document.getElementById('canvas');

      send('pointerdown', { x: 240, y: 240 }, null, { button: 1 });
      send('pointermove', { x: 300, y: 300 }, null, { button: 1 });

      check('a pan drag marks the canvas as being panned',
        canvasEl.classList.contains('is-panning'));

      window.dispatchEvent(new CustomEvent('dmd:modal-opened'));
      send('pointerup', { x: 300, y: 300 }, null, { button: 1 });

      check('and that mark goes with the drag rather than outliving it',
        !canvasEl.classList.contains('is-panning'));

      // A drag whose document is replaced under it. The ids it is holding name nothing in the new one,
      // so the release must not commit an empty move - an undo entry and a dirty flag on a freshly
      // opened file.
      const moving = state.newAnnotation('note', { x: 300, y: 300 });
      state.state.doc.annotations.push(moving);
      state.selectOnly('annotations', moving.id);
      geometry.invalidateSizes();
      render.render();

      const noteNode = find(document.getElementById('layer-annotations-front'), node =>
        node.getAttribute && node.getAttribute('data-kind') === 'annotation' &&
        node.getAttribute('data-id') === moving.id);

      const grab = interactions.toScreen(moving.x + 40, moving.y + 40);

      send('pointerdown', grab, noteNode);
      send('pointermove', { x: grab.x + 60, y: grab.y + 60 });

      state.setDocument(state.newDocument('Somewhere else'), null);
      state.setDirty(false);
      geometry.invalidateSizes();
      render.render();

      send('pointerup', { x: grab.x + 60, y: grab.y + 60 });

      check('a drag whose document is replaced does not commit into the one that arrives',
        state.state.dirty === false && state.canUndo() === false,
        'dirty ' + state.state.dirty + ', undo ' + state.canUndo());

      // Put the note back on the canvas under the same id: the document it lived in has just been
      // replaced, and the inspector checks below are about that note.
      const revived = state.newAnnotation('note', { x: 100, y: 100 });
      revived.id = note.id;
      revived.width = 160;
      revived.height = 160;
      state.state.doc.annotations.push(revived);
      geometry.invalidateSizes();
      render.render();
    }

    // ---- the inspector's box, which is the only way in without a mouse
    state.selectOnly('annotations', note.id);
    live().tilt = 12;
    inspectorModule.refreshInspector();

    const angleField = find(inspectorBody(), node =>
      node.classList && node.classList.contains('field') &&
      String(node.textContent).trim().startsWith('Angle'));
    const angleSelect = angleField ? find(angleField, node => node.tagName === 'select') : null;

    check('the inspector offers a note an angle box', !!angleSelect,
      String(inspectorBody().textContent).slice(0, 160));
    check('which opens on the angle the note is standing at',
      !!angleSelect && angleSelect.value === '12', angleSelect && angleSelect.value);

    pickOption(angleSelect, '0');
    check('and squaring it to the page is one of the choices',
      live().tilt === 0, String(live().tilt));

    // The handle turns a note a half turn either way and the box is the only way in without a mouse,
    // so the list must cover the whole range - a list that stopped at 45 degrees could not put a note
    // back to 90.
    const offered = Array.from(angleSelect.childNodes)
      .map(node => String(node.value))
      .filter(Boolean);

    check('and the box reaches every angle the handle does',
      offered.includes('90') && offered.includes('-180'), offered.join(', '));

    // wrapDegrees folds into [-180, 180), so the handle can never produce +180. Listing it as well
    // would be two entries for one note, and picking the one it was not standing at would appear
    // to do nothing.
    check('and lists a half turn once rather than twice',
      !offered.includes('180'), offered.join(', '));

    state.selectOnly('annotations', textBox.id);
    inspectorModule.refreshInspector();

    check('a text box is not offered one',
      !find(inspectorBody(), node =>
        node.classList && node.classList.contains('field') &&
        String(node.textContent).trim().startsWith('Angle')));

    state.clearSelection();
    inspectorModule.hideInspector();
  }

  // ---- leave the environment as it was found

  uiModule.closeModal();
  state.clearSelection();
  inspectorModule.hideInspector();
  sourcepickerModule.invalidateCatalogue();
  state.state.connection = { connected: false };
}

// ------------------------------------------------- cross-runtime interop --
// The host serialises the diagram in C# and the canvas reads it in JavaScript. This proves the
// two agree on the wire shape rather than each being internally consistent on its own.

// --------------------------------------------------------- module graph --
// The dialog modules are not driven headlessly - they need a real DOM - but importing them still
// proves the module graph resolves: no missing export, no typo in an import, no cycle that leaves
// a binding undefined at load. Those are exactly the mistakes that show up as a blank dialog in
// XrmToolBox and nowhere else.

console.log('\nModule graph');
const ui = await import(js + 'ui.js');
const proposed = await import(js + 'proposed.js');
const inspector = await import(js + 'inspector.js');
const panels = await import(js + 'panels.js');
const interact = await import(js + 'interact.js');
const dialogs = await import(js + 'dialogs.js');
const exporter = await import(js + 'exporter.js');
const sourcepicker = await import(js + 'sourcepicker.js');
const explorer = await import(js + 'explorer.js');
const cascade = await import(js + 'cascade.js');

check('the required-field helpers are exported',
  typeof ui.markRequired === 'function' && typeof ui.cellInput === 'function');
check('the proposed table editor is exported', typeof proposed.openProposedTableEditor === 'function');
check('the proposed column editor is exported', typeof proposed.openProposedColumnEditor === 'function');
check('removing a proposed column is exported', typeof proposed.removeProposedColumn === 'function');
check('the inspector still exports its entry point', typeof inspector.refreshInspector === 'function');
check('the panels still export theirs', typeof panels.renderPanels === 'function');
check('zoom presets have something to call', typeof interact.zoomTo === 'function');
check('the path finder is exported', typeof dialogs.openPathFinder === 'function');
check('the export dialog is exported', typeof exporter.openExportDialog === 'function');
check('the source picker is exported', typeof sourcepicker.openSourcePicker === 'function');
check('the renderer can rebuild its theme', typeof render.refreshRendererTheme === 'function');
check('the depth explorer is exported', typeof explorer.openExplorer === 'function');
check('cascade impact is exported', typeof cascade.openCascadeAnalysis === 'function');
check('the propose hub is exported', typeof proposed.openProposeHub === 'function');
check('the proposed relationship editor is exported',
  typeof proposed.openProposedRelationshipEditor === 'function');
check('the feature guide is exported', typeof dialogs.openFeatureGuide === 'function');
check('connect mode is exported',
  typeof interact.startConnectMode === 'function' && typeof interact.endConnectMode === 'function');
check('the layout pass that nothing called is gone',
  typeof layout.separateOverlaps === 'undefined');

// inspector.js and proposed.js reference each other's editors. If that cycle were resolved the
// wrong way round, one of these would be undefined at load rather than at first click.
check('the inspector/proposed cycle resolves both ways',
  typeof inspector.refreshInspector === 'function' &&
  typeof proposed.setTableStatus === 'function');

console.log('\nDialogs that can be opened headlessly');

// openModal builds its body synchronously and the builder calls model.validate() to put the dialog
// into its starting state, so openProposedTableEditor must assign model.validate before calling
// openModal - or proposing a table throws "model.validate is not a function".
//
// This dialog is simple enough to open against the DOM shim, so it is pinned by opening it rather
// than by reading the source: a static check would only prove the two lines are in a particular
// order, not that the dialog builds.
{
  let thrown = null;
  try { proposed.openProposedTableEditor(); }
  catch (error) { thrown = error; }

  check('proposing a table builds its dialog', thrown === null,
    thrown && thrown.message);

  let editThrown = null;
  try { proposed.openProposedTableEditor(acct.id); }
  catch (error) { editThrown = error; }

  check('editing an existing table design builds its dialog', editThrown === null,
    editThrown && editThrown.message);

  ui.closeModal();
}

// The overflow menu grows with everything the command bar has shelved. On a short window it must
// not measure taller than the screen, or the position clamp produces a negative top and puts the
// first items - the commands just taken off the toolbar - off the edge of the display.
{
  ui.showContextMenu(400, 880, Array.from({ length: 40 }, (unused, i) => ({
    text: 'Item ' + i, run: () => {}
  })));

  const menu = document.getElementById('context-menu');
  const top = parseFloat(menu.style.top);
  const cap = parseFloat(menu.style.maxHeight);

  check('a tall menu is capped to the window', cap > 0 && cap <= window.innerHeight, String(cap));
  check('a tall menu never starts above the top of the window', top >= 0, String(top));

  ui.hideContextMenu();
}

console.log('\nThe command bar and its overflow menu agree');

// The responsive pass hides toolbar buttons and the overflow menu puts them back. Both are driven
// from one table, so a renamed button cannot appear on the bar *and* in the menu meant to replace
// it. This proves the table still covers the bar it is describing.
{
  const fs = await import('node:fs');
  const appSource = fs.readFileSync('../../src/Oliver4.DataModelDesigner/Web/js/app.js', 'utf8');
  const html = fs.readFileSync('../../src/Oliver4.DataModelDesigner/Web/index.html', 'utf8');

  const actions = /<div class="bar-actions">([\s\S]*?)<\/div>/.exec(html);
  const onBar = Array.from((actions ? actions[1] : '').matchAll(/data-command="([^"]+)"/g))
    .map(m => m[1])
    .filter(name => name !== 'add-tables');   // Add tables never leaves; it is the empty-canvas action.

  const covered = Array.from(appSource.matchAll(/key: '([^']+)', selector:/g)).map(m => m[1]);

  const missing = onBar.filter(name => !covered.includes(name));
  check('every canvas action on the bar can be shelved and reappears in the menu',
    missing.length === 0, missing.join(', '));

  // Every shelvable entry has to produce something in the menu, or shelving it makes it
  // unreachable rather than one click further away.
  const entries = appSource.split(/\{ key: '/).slice(1);
  const silent = entries
    .filter(block => !/menu:|detail: true|label:/.test(block.slice(0, 400)))
    .map(block => block.slice(0, block.indexOf("'")));

  check('nothing can be shelved without a way back', silent.length === 0, silent.join(', '));

  // ---- the Draw group, and the renamed buttons
  //
  // The group has to empty from its right-hand end as the window narrows, or shelving opens a gap
  // in the middle of it. Auto-layout sits last on the bar, so it is first in the shelving table -
  // the two orders are deliberately opposite and this is what says so.
  const drawGroup = /<span class="bar-divider draw-divider">[\s\S]*?<\/div>/.exec(html);
  const drawCommands = Array.from((drawGroup ? drawGroup[0] : '').matchAll(/data-command="([^"]+)"/g))
    .map(m => m[1]);

  check('Auto-layout sits at the end of the Draw group on the bar',
    drawCommands[drawCommands.length - 1] === 'auto-layout', drawCommands.join(', '));
  check('and is shelved at the head of it, so the group empties from the right',
    covered.indexOf('auto-layout') >= 0 &&
    covered.indexOf('auto-layout') < covered.indexOf('add-arrow'),
    covered.join(', '));

  const labelFor = command => {
    const match = new RegExp('data-command="' + command + '"[^>]*>([^<]*)<').exec(html);
    return match ? match[1].trim() : null;
  };

  check('the three model buttons say what they do',
    labelFor('add-tables') === 'Add existing tables' &&
    labelFor('propose') === 'Propose new tables' &&
    labelFor('explore') === 'Explore relationships',
    [labelFor('add-tables'), labelFor('propose'), labelFor('explore')].join(' | '));

  // A button and a menu entry with different names are two names for one command, which is the
  // drift this whole section exists to catch.
  check('and the overflow menu calls Propose the same thing the button does',
    /text: 'Propose new tables\.\.\.'/.test(appSource));
}

// ---- the legend is furniture, and furniture goes under the panels
//
// A draggable legend could otherwise be parked on top of the table or relationship inspector,
// hiding the thing being read. Stacking, not clamping: it can still be dragged anywhere.
{
  const css = (await import('node:fs')).readFileSync(
    '../../src/Oliver4.DataModelDesigner/Web/css/app.css', 'utf8');

  const depthOf = selector => {
    const rule = new RegExp('(^|\\})\\s*' + selector + '\\s*\\{([^}]*)\\}', 'm').exec(css);
    const found = rule ? /z-index:\s*(-?\d+)/.exec(rule[2]) : null;
    return found ? Number(found[1]) : null;
  };

  const legendDepth = depthOf('\\.legend');
  const panelDepth = depthOf('\\.panel');

  check('the legend and the panels both declare a stacking order',
    legendDepth !== null && panelDepth !== null, legendDepth + ' against ' + panelDepth);
  check('and the legend is underneath them',
    legendDepth < panelDepth, legendDepth + ' against ' + panelDepth);

  // Underneath is not the same as invisible. The legend's default corner is directly below the
  // inspector and the two overlap by about sixty pixels on a tall panel, so without this the legend
  // would be hidden on an untouched diagram - its own right-click menu unreachable under the panel,
  // and Display settings offering no reset because it has never been moved.
  check('and the default corner steps out of the inspector\'s column while that panel is open',
    /body\.inspector-open \.legend\s*\{[^}]*right:/.test(css),
    (/[^\n]*inspector-open[^\n]*/.exec(css) || ['no such rule'])[0].trim());
}

// ---- and the class that rule keys off is really put on the body
{
  const inspectorModule = await import(js + 'inspector.js');
  const bodyClasses = () => Array.from(document.body.classList.set || []).join(' ');

  state.setDocument(state.newDocument('Legend against the inspector'), null);
  state.clearSelection();

  // Forced on first. The section before this one ends by hiding the inspector, so without this the
  // check below would pass on a class that was already off. Clearing the selection is also the
  // route the inspector really closes by in the running app, and it is a different line from the
  // one hideInspector uses.
  document.body.classList.add('inspector-open');
  inspectorModule.refreshInspector();

  check('nothing selected, so the inspector is shut and the legend keeps its corner',
    !document.body.classList.contains('inspector-open'), bodyClasses());

  const note = state.newAnnotation('note', { x: 0, y: 0 });
  state.state.doc.annotations.push(note);
  state.selectOnly('annotations', note.id);
  inspectorModule.refreshInspector();

  check('and it steps aside as soon as the inspector opens',
    document.body.classList.contains('inspector-open'), bodyClasses());

  inspectorModule.hideInspector();

  check('and takes its corner back when the panel closes',
    !document.body.classList.contains('inspector-open'), bodyClasses());

  state.clearSelection();
}

console.log('\nBoot-order safety in app.js');

// app.js is the only module with executable code at the top level, and the smoke test cannot
// import it (its boot sequence needs the whole command bar and the host bridge). A `let` declared
// below the boot block would be read in its temporal dead zone by paintChrome() ->
// layoutCommandBar() and the tool would open on an error toast. So this checks statically that
// every top-level binding in app.js is declared before the first top-level statement that runs.
{
  const appSource = (await import('node:fs')).readFileSync(
    '../../src/Oliver4.DataModelDesigner/Web/js/app.js', 'utf8');
  const lines = appSource.split('\n');

  const isNoise = line =>
    line.trim() === '' || /^\s*(\/\/|\/\*|\*|\*\/)/.test(line);

  // A top-level statement starts in column 0 and is not a declaration or an import.
  const firstRun = lines.findIndex(line =>
    !isNoise(line) &&
    /^[A-Za-z_$]/.test(line) &&
    !/^(import|export|function|async function|let |const |var |class )/.test(line));

  const lateBindings = lines
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(x => firstRun >= 0 && x.n > firstRun + 1 && /^(let|const) /.test(x.line))
    .map(x => x.n + ': ' + x.line.trim());

  check('app.js runs nothing at the top level before its bindings exist',
    lateBindings.length === 0, lateBindings.join(', '));

  // ------------------------------------------------------------ app.js guards ----
  //
  // These behaviours live in app.js, so they are pinned the same way and for the same reason:
  // app.js boots the app. Importing it here would run the whole boot sequence - the command bar,
  // the host bridge, the source picker opening on top of everything - against a DOM shim that has
  // none of it, so there is no behavioural route to any of these and a source check is the honest
  // alternative to no check at all.
  //
  // Each one is written against the shape of the guard rather than against a word anywhere in the
  // file, so removing the guard fails it and moving the code around does not.

  // Comments are stripped throughout: several of these guards are explained in a comment directly
  // above themselves, and a check the explanation satisfies proves nothing.
  const appCode = appSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const functionBody = (source, header, ending) => {
    const start = source.indexOf(header);
    if (start < 0) return '';
    const end = source.indexOf(ending, start);
    return end < 0 ? source.slice(start) : source.slice(start, end);
  };

  // J9 - saveDiagram writes the dirty flag through setDirty. setDirty is the only thing that tells
  // the host, which is what makes XrmToolBox drop its modified marker; and because it early-returns
  // when the value has not changed, assigning the field by hand would also stop every later edit in
  // the session from notifying at all.
  {
    const save = functionBody(appCode, 'async function saveDiagram(', '\n/**');

    check('the saveDiagram body was found', save.includes('host.saveDiagram('), save.length + ' chars');
    check('saving clears the dirty flag through setDirty', /\bsetDirty\s*\(\s*false\s*\)/.test(save));
    check('and never assigns state.dirty behind its back',
      !/state\s*\.\s*dirty\s*=/.test(save),
      (/state\s*\.\s*dirty\s*=.*/.exec(save) || [''])[0].trim());
  }

  // J10 - the unhandledrejection handler filters cancellations before it counts. A cancellation is
  // how the host answers a request it was told to stop, so counting them would let three abandoned
  // path searches spend all three reports and silence the reporter for the rest of the session.
  {
    const handler = functionBody(appCode, "window.addEventListener('unhandledrejection'", '\n}\n');

    check('the unhandledrejection handler was found',
      handler.includes('report('), handler.length + ' chars');

    const guard = handler.search(/if\s*\(\s*isCancellation\s*\([\s\S]{0,40}\)\s*\)\s*return\s*;/);
    const counted = handler.search(/\breport\s*\(/);

    check('a cancellation is recognised and dropped', guard >= 0, String(guard));
    check('and that happens before anything is counted or reported',
      guard >= 0 && counted > guard, guard + ' vs ' + counted);
  }

  // J11 - the Ctrl-shortcuts stop at a text field and at an open dialog. Otherwise Ctrl+Z in a text
  // box blocks the box's own undo and reverts a canvas edit instead, and Ctrl+O with a dialog open
  // replaces the document while the dialog carries on editing the one it was built from.
  {
    const shortcuts = functionBody(appCode, 'function wireGlobalShortcuts(', "window.addEventListener('resize'");

    check('the wireGlobalShortcuts body was found',
      shortcuts.includes("key === 'o'"), shortcuts.length + ' chars');

    // One guard testing both, and it has to return. Two separate ifs would pass a naive word search
    // while still letting one of them be deleted.
    check('one guard stops the canvas shortcuts at both a text field and an open dialog',
      /if\s*\(\s*isTypingTarget\s*\([^)]*\)\s*\|\|\s*isModalOpen\s*\(\s*\)\s*\)\s*return\s*;/.test(shortcuts),
      (/if\s*\([^\n]*isModalOpen[^\n]*/.exec(shortcuts) || ['no isModalOpen guard'])[0].trim());

    // Save is intentionally above the guard - it runs wherever focus is - so the guard must not be
    // the first thing in the handler either.
    check('and Save is still handled above it, because it runs wherever focus is',
      shortcuts.search(/key === 's'/) >= 0 &&
      shortcuts.search(/key === 's'/) < shortcuts.search(/isTypingTarget/),
      shortcuts.search(/key === 's'/) + ' vs ' + shortcuts.search(/isTypingTarget/));
  }

  // J12 - what floats over a canvas whose document has just been replaced. A context menu item
  // captures the object it was opened on, and an open dialog edits the document it was built from;
  // neither may survive an Open, or the menu's "Collapse card" would toggle a table in the discarded
  // document and mark the new diagram dirty.
  {
    const subscribers = appCode.split('subscribe(').slice(1);
    const replacing = subscribers.find(block => block.includes("'document-replacing'"));

    check('app.js subscribes to document-replacing', !!replacing);
    check('and a document being replaced dismisses the context menu',
      !!replacing && /hideContextMenu\s*\(\s*\)/.test(replacing.slice(0, 400)),
      replacing && replacing.slice(0, 200).replace(/\s+/g, ' '));
    check('and closes the open dialog with it',
      !!replacing && /closeModal\s*\(\s*\)/.test(replacing.slice(0, 400)));

    // The other half: a menu item that outlives its document must not still be holding the object.
    // Both branches capture the id once, up front, and every run: closure works from that.
    const menu = functionBody(appCode, 'function showCanvasMenu(', '\nfunction openEditorFor(');

    check('the showCanvasMenu body was found', menu.includes('showContextMenu('), menu.length + ' chars');
    check('the table branch captures the table id up front',
      /const\s+tableId\s*=\s*table\.id\s*;/.test(menu));
    check('the relationship branch captures the relationship id up front',
      /const\s+relationshipId\s*=\s*relationship\.id\s*;/.test(menu));

    // One reference each - the capture itself. Any other `table.id` in this function is an id read
    // off a live object at the moment the item runs, which is the thing being pinned against.
    const tableIdReads = (menu.match(/table\.id/g) || []).length;
    const relationshipIdReads = (menu.match(/relationship\.id/g) || []).length;

    check('and no menu item reads an id off the captured table object when it runs',
      tableIdReads === 1, tableIdReads + ' references to table.id');
    check('nor off the captured relationship object',
      relationshipIdReads === 1, relationshipIdReads + ' references to relationship.id');
  }

  // ---- app.js cannot be imported, so the wiring is pinned from its source

  {
    check('app.js places the legend every time it paints the chrome',
      /applyLegendPosition\s*\(\s*\)/.test(appCode.slice(appCode.indexOf('function paintChrome('),
        appCode.indexOf('function paintLegend('))));

    const drag = appCode.slice(appCode.indexOf('function initLegendDrag('),
      appCode.indexOf('function applyLegendPosition('));

    check('the legend drag was wired', drag.includes("addEventListener('pointerdown'"),
      drag.length + ' chars');
    check('and it tracks the pointer on the window, not on the legend it is dragging',
      /window\.addEventListener\('pointermove'/.test(drag) &&
      /window\.addEventListener\('pointerup'/.test(drag));
    // The legend colour rename. The legend drag takes pointer capture on every press, and while an
    // element holds the capture the browser retargets the click to *it* - so a click listener on the
    // colour row inside #legend would never be called. The rename is driven from the release instead.
    const press = drag.slice(drag.indexOf("addEventListener('pointerdown'"),
      drag.indexOf("window.addEventListener('pointermove'"));

    check('the legend does not take the pointer capture on the press',
      press.length > 80 && !/setPointerCapture/.test(press),
      press.length + ' chars');
    check('it takes it once the press has become a drag, so a release outside the view arrives',
      /moved = true[\s\S]{0,900}setPointerCapture/.test(drag));
    check('a press that never moved renames the colour it went down on',
      /if \(!drag\.moved\)[\s\S]{0,240}renameEmphasis\(drag\.colour\)/.test(drag));
    check('and a drag that ends on a colour row does not also rename that colour',
      /if \(!drag\.moved\)/.test(drag) &&
      drag.indexOf('renameEmphasis') > drag.indexOf('if (!drag.moved)'));
    check('the colour is read off the row on the way down, not from a click on it',
      /closest\('\.legend-named'\)/.test(drag) && !/addEventListener\('click'/.test(drag));
    check('and right-clicking the legend offers a way to put it back',
      /contextmenu/.test(drag) && /showLegendMenu/.test(drag));

    const commit = appCode.slice(appCode.indexOf('function onLegendPointerUp('),
      appCode.indexOf('function applyLegendPosition('));

    check('the move is committed as one undoable step',
      /mutate\('move legend'/.test(commit), commit.slice(0, 200).replace(/\s+/g, ' '));

    // The clamp belongs to the drawing, not to the store: re-clamping into the settings would
    // lose where the user actually put it the first time the window was made small.
    const apply = appCode.slice(appCode.indexOf('function applyLegendPosition('),
      appCode.indexOf('function showLegendMenu('));

    check('a legend with no stored position falls back to the stylesheet corner',
      /legend\.style\.left\s*=\s*''/.test(apply) && /legend\.style\.right\s*=\s*''/.test(apply),
      apply.slice(0, 300).replace(/\s+/g, ' '));
    check('and resizing the window re-places it rather than rewriting where it was put',
      /resize'[\s\S]{0,160}applyLegendPosition\s*\(\s*\)/.test(appCode) &&
      !/resize'[\s\S]{0,160}legendX\s*=/.test(appCode));

    // Legend drag edge cases.

    // The rename is driven from the release rather than from a click, so there is no click to
    // suppress and nothing listening for one - including the click some browsers dispatch on the body
    // at the end of a drag into a corner.
    const legendCss = (await import('node:fs')).readFileSync(
      '../../src/Oliver4.DataModelDesigner/Web/css/app.css', 'utf8');

    check('the legend still paints the pencil that says a colour row can be renamed',
      /\.legend-named:hover::after\s*\{[^}]*content/.test(legendCss));

    check('a drag is dropped rather than committed when the document is replaced',
      /'document-replacing'[\s\S]{0,400}cancelLegendDrag\s*\(\s*\)/.test(appCode));
    check('and when the window loses focus mid-drag',
      /addEventListener\('blur',\s*cancelLegendDrag\)/.test(drag));

    // Releasing the other button is not the end of this drag: it must not commit the move and leave
    // the legend stuck to a pointer nothing is tracking.
    check('releasing a different button does not end the drag',
      /event\.button !== 0\) return;/.test(commit), commit.slice(0, 300).replace(/\s+/g, ' '));

    // paintChrome runs on every notification, including one per wheel tick. Measuring the legend
    // and writing four style properties on each of those is the work the command bar and the
    // legend rows both carry a signature guard to avoid.
    check('placing the legend is guarded like the rest of the chrome',
      /if\s*\(\s*signature === lastLegendPlacement\s*\)\s*return\s*;/.test(apply),
      apply.slice(0, 400).replace(/\s+/g, ' '));

    // "Sticky note here" from the canvas menu centres the note on the click, using the same size as
    // the toolbar tool - the comment above centreOn exists because those two must agree.
    // The same command as the inspector's Depth box, on the menu where the user already right-clicks
    // to delete an annotation - and it re-resolves the annotation by id when it runs, because a menu
    // outlives the document it was opened on.
    const annotationMenu = appCode.slice(appCode.indexOf('const annotationId = hit.id;'),
      appCode.indexOf('function openEditorFor('));

    check('the annotation menu offers to send it behind the model and to bring it back',
      /'Bring in front of the model'/.test(annotationMenu) &&
      /'Send behind the model'/.test(annotationMenu),
      annotationMenu.slice(0, 200).replace(/\s+/g, ' '));
    check('and it re-resolves the annotation by id rather than writing to the captured object',
      /annotations \|\| \[\]\)\.find\(entry => entry\.id === annotationId\)/.test(annotationMenu));

    // Re-resolving and then writing a value captured when the menu opened would still be wrong, so
    // the side it writes must come from the re-resolved object too.
    check('and the side it writes comes from that object, not from the captured one',
      /target\.behind = !annotationBehind\(target\)/.test(annotationMenu),
      (/[^\n]*\.behind = [^\n]*/.exec(annotationMenu) || ['none'])[0].trim());

    check('the canvas menu centres a sticky note on its real width',
      /centreOn\(point, NOTE_DEFAULT_SIZE\)/.test(appCode) && !/centreOn\(point, 180\)/.test(appCode),
      (/[^\n]*centreOn\(point[^\n]*/.exec(appCode) || ['none'])[0].trim());

    // Further legend and pointer edge cases.

    // A hidden legend measures 0x0, so a placement worked out while it is switched off must not be
    // cached as a real one - the guard would then skip the placement needed on the way back, leaving
    // a moved legend hard against the far edge of a window that has since been resized.
    check('a hidden legend is not measured, and does not poison the guard',
      /if\s*\(\s*legend\.hidden\s*\)\s*\{\s*lastLegendPlacement = null;\s*return;/.test(apply),
      apply.slice(0, 400).replace(/\s+/g, ' '));
    check('and placing it is not left inside the branch that draws its rows',
      /if \(doc\.settings\.showLegend\) paintLegend\(\);/.test(appCode) &&
      /\n  applyLegendPosition\(\);/.test(appCode));

    // A cancelled pointer is the gesture being taken away, not the drag finishing. Committing it would
    // write half a move into the diagram and leave the click suppressor armed with no click coming.
    check('a cancelled pointer drops the drag rather than committing it',
      /window\.addEventListener\('pointercancel', cancelLegendDrag\)/.test(drag),
      (/[^\n]*pointercancel[^\n]*/.exec(drag) || ['none'])[0].trim());
    check('a released button that was never reported ends the drag too',
      /event\.buttons === 0/.test(appCode));
    check('and the drag is captured, so a release outside the view still arrives',
      /setPointerCapture/.test(drag));

  }

}

// =====================================================================
// Moving a connector in two directions, moving a field up a card,
// and pointing at the lookup when two cards are stacked
// =====================================================================
{
  const interactions = await import(js + 'interact.js');
  const uiModule = await import(js + 'ui.js');
  const panelsModule = await import(js + 'panels.js');

  const canvasNode = document.getElementById('canvas');

  interactions.initInteractions({
    onSelectionChange: () => {}, onContextMenu: () => {}, onOpenEditor: () => {},
    onConnect: () => {}, onAnnotationPlaced: () => {}
  });

  // initInteractions has run more than once in this file, so the canvas carries the handlers from
  // every earlier call. A Set sends each distinct one exactly once - they all read the same module
  // state, so dispatching to a stale closure would drive the same drag twice.
  const nowhere = { closest: () => null, tagName: 'svg' };
  const pointer = (type, x, y, options) => {
    const event = Object.assign({
      type, pointerId: 1, clientX: x, clientY: y, button: 0,
      shiftKey: false, ctrlKey: false, altKey: false,
      target: nowhere,
      preventDefault() {}, stopPropagation() {}
    }, options || {});

    for (const handler of new Set(canvasNode.listeners[type] || [])) handler(event);
  };

  const findNode = (root, predicate) => {
    for (const child of root.childNodes) {
      if (predicate(child)) return child;
      const deeper = findNode(child, predicate);
      if (deeper) return deeper;
    }
    return null;
  };

  const column = (id, logicalName, displayName, extra) => Object.assign({
    id, logicalName, schemaName: logicalName, displayName,
    typeName: 'Text (100)', isPrimaryId: false, isPrimaryName: false, isLookup: false,
    targets: [], selected: true, status: 'Existing'
  }, extra || {});

  const card = (id, logicalName, displayName, columns) => ({
    id, logicalName, schemaName: displayName.replace(/\s/g, ''), displayName,
    status: 'Existing', x: 0, y: 0, collapsed: false, detailOverride: null,
    highlight: null, notes: '', alternateKeys: [], columnOrder: [],
    primaryIdAttribute: logicalName + 'id', primaryNameAttribute: 'name',
    columns: [
      column(id + 'pk', logicalName + 'id', 'Identifier', { isPrimaryId: true, typeName: 'Unique identifier' }),
      column(id + 'nm', 'name', 'Name', { isPrimaryName: true }),
      ...(columns || [])
    ]
  });

  const fresh = title => {
    state.setDocument(state.newDocument(title), null);
    geometry.invalidateSizes();
    return state.state.doc;
  };

  uiModule.closeModal();
  state.clearSelection();

  // -----------------------------------------------------------------
  console.log('\nA connector can be dragged in both directions');
  // -----------------------------------------------------------------
  //
  // A connector has two offsets, one along each axis, so a line can be parted from the ones it
  // overlaps in either direction. The second is written so that at zero it draws exactly the route
  // the first alone draws - the shape must not jump as a drag crosses the axis.
  {
    const doc = fresh('Two axes');

    const left = card('t-left', 'account', 'Account');
    const right = card('t-right', 'contact', 'Contact', [
      column('t-rightfk', 'parentcustomerid', 'Customer', { isLookup: true, targets: ['account'] })
    ]);

    left.x = 0; left.y = 0;
    right.x = 600; right.y = 220;
    doc.tables.push(left, right);

    const link = {
      id: 'r-two-axes', schemaName: 'cs_two_axes', kind: 'OneToMany', status: 'Existing',
      fromTableId: left.id, toTableId: right.id,
      referencedAttribute: 'accountid', referencingAttribute: 'parentcustomerid',
      included: true, hidden: false, waypoints: [], lookupTargets: []
    };
    doc.relationships.push(link);
    doc.settings.fieldDetail = 'RelationshipFields';
    geometry.invalidateSizes();

    const plain = geometry.routeRelationship(link, 0, 1);

    check('the fixture is an ordinary side-to-side route with a row at each end',
      plain.offsetAxis === 'x' && plain.crossAxis === 'y' && plain.points.length === 4,
      plain.offsetAxis + '/' + plain.crossAxis + ' ' + plain.points.length + ' points');

    link.routeOffsetCross = 0;
    check('a cross offset of zero draws exactly the route it drew before there was one',
      JSON.stringify(geometry.routeRelationship(link, 0, 1).points) === JSON.stringify(plain.points));

    link.routeOffsetCross = 90;
    const shifted = geometry.routeRelationship(link, 0, 1);

    check('a cross offset moves the middle of the route',
      shifted.points.some(p => Math.abs(p.y - (plain.start.y + 90)) < 0.01),
      JSON.stringify(shifted.points));
    check('and leaves both end anchors exactly where they were',
      shifted.start.x === plain.start.x && shifted.start.y === plain.start.y &&
      shifted.end.x === plain.end.x && shifted.end.y === plain.end.y);

    // Every leg of the route has to stay axis-aligned, or the line stops reading as an orthogonal
    // connector and the crossing bridges - which only look at horizontal legs - stop finding it.
    const skew = geometry.segmentsOf(shifted.points).filter(s =>
      Math.abs(s.a.x - s.b.x) > 0.01 && Math.abs(s.a.y - s.b.y) > 0.01);
    check('every leg of a shifted route is still horizontal or vertical', skew.length === 0,
      JSON.stringify(skew));

    // And no leg of zero length: pathFromPoints rounds a corner from the directions either side of
    // it, and a corner with nothing on one side has no direction to round.
    const stalled = geometry.segmentsOf(shifted.points).filter(s =>
      Math.abs(s.a.x - s.b.x) < 0.01 && Math.abs(s.a.y - s.b.y) < 0.01);
    check('and none of them has zero length', stalled.length === 0, JSON.stringify(shifted.points));

    // Both offsets at once.
    link.routeOffset = 120;
    const both = geometry.routeRelationship(link, 0, 1);
    check('the two offsets move the route independently',
      JSON.stringify(both.points) !== JSON.stringify(shifted.points) &&
      both.start.y === plain.start.y && both.end.y === plain.end.y);

    link.routeOffset = 0;
    link.routeOffsetCross = 0;
  }

  // Cards with no room between them for the route to turn in.
  //
  // The shapes collapse rather than refuse - a cross offset that cannot be honoured draws the route
  // it would have drawn without one - and collapsing is what puts two points on top of each other.
  // A leg of zero length gives pathFromPoints a corner with no direction to round it from, and
  // midpointOf a label position that is not on the drawn line.
  {
    const doc = fresh('No room to turn');

    const left = card('n-left', 'account', 'Account');
    const right = card('n-right', 'contact', 'Contact', [
      column('n-rightfk', 'parentcustomerid', 'Customer', { isLookup: true, targets: ['account'] })
    ]);

    doc.tables.push(left, right);
    doc.settings.fieldDetail = 'AllFields';
    geometry.invalidateSizes();

    left.x = 0; left.y = 0;
    right.x = geometry.tableRect(left).width + 40; right.y = 130;

    const link = {
      id: 'r-cramped', schemaName: 'cs_cramped', kind: 'OneToMany', status: 'Existing',
      fromTableId: left.id, toTableId: right.id,
      referencedAttribute: 'accountid', referencingAttribute: 'parentcustomerid',
      included: true, hidden: false, waypoints: [], lookupTargets: []
    };
    doc.relationships.push(link);
    geometry.invalidateSizes();

    let stalled = null;
    let doubled = null;

    for (const along of [-900, -120, -14, -1, 0, 1, 14, 120, 900]) {
      for (const across of [-500, -60, -1, 0, 1, 60, 500]) {
        link.routeOffset = along;
        link.routeOffsetCross = across;

        const route = geometry.routeRelationship(link, 0, 1);
        const where = along + '/' + across + ' ' + JSON.stringify(route.points);

        if (geometry.segmentsOf(route.points).some(leg =>
          Math.abs(leg.a.x - leg.b.x) < 0.01 && Math.abs(leg.a.y - leg.b.y) < 0.01)) stalled = where;

        for (let i = 1; i < route.points.length - 1; i++) {
          const before = route.points[i - 1];
          const here = route.points[i];
          const after = route.points[i + 1];
          if ((Math.abs(before.x - here.x) < 0.01 && Math.abs(here.x - after.x) < 0.01) ||
              (Math.abs(before.y - here.y) < 0.01 && Math.abs(here.y - after.y) < 0.01)) doubled = where;
        }
      }
    }

    check('a route with no room to turn still has no leg of zero length', stalled === null, stalled);
    check('and no corner that turns through nothing', doubled === null, doubled);

    link.routeOffset = 0;
    link.routeOffsetCross = 0;
  }

  // -----------------------------------------------------------------
  console.log('\nThe drag writes both offsets as one undoable step');
  // -----------------------------------------------------------------
  {
    const doc = fresh('Dragging both ways');

    const left = card('d-left', 'account', 'Account');
    const right = card('d-right', 'contact', 'Contact', [
      column('d-rightfk', 'parentcustomerid', 'Customer', { isLookup: true, targets: ['account'] })
    ]);

    left.x = 0; left.y = 0;
    right.x = 600; right.y = 220;
    doc.tables.push(left, right);

    const link = {
      id: 'r-dragged-both', schemaName: 'cs_dragged_both', kind: 'OneToMany', status: 'Existing',
      fromTableId: left.id, toTableId: right.id,
      referencedAttribute: 'accountid', referencingAttribute: 'parentcustomerid',
      included: true, hidden: false, waypoints: [], lookupTargets: []
    };
    doc.relationships.push(link);
    doc.settings.fieldDetail = 'RelationshipFields';
    geometry.invalidateSizes();

    state.state.view = { zoom: 1, panX: 0, panY: 0 };
    render.render();

    const route = geometry.routeRelationship(link, 0, 1);
    const grab = interactions.toScreen(route.label.x, route.label.y);

    pointer('pointerdown', grab.x, grab.y);
    pointer('pointermove', grab.x + 40, grab.y + 25);
    pointer('pointerup', grab.x + 40, grab.y + 25);

    check('dragging a connector diagonally writes both offsets',
      Math.abs(link.routeOffset - 40) < 0.01 && Math.abs(link.routeOffsetCross - 25) < 0.01,
      link.routeOffset + ' / ' + link.routeOffsetCross);
    check('and it is one undoable step, not two',
      state.canUndo());

    state.undo();
    const undone = state.relationshipById('r-dragged-both');

    check('undo puts both back', !undone.routeOffset && !undone.routeOffsetCross,
      undone.routeOffset + ' / ' + undone.routeOffsetCross);
  }

  // -----------------------------------------------------------------
  console.log('\nStacked cards keep the connector on the lookup field');
  // -----------------------------------------------------------------
  //
  // A run between two cards one above the other must not simply meet the top or bottom edge: no
  // point along that edge can pick out a row, because the rows are stacked in the same direction.
  // The route goes round the side instead, so the line points at the lookup rather than just the
  // table.
  {
    const doc = fresh('Stacked');

    const above = card('s-above', 'account', 'Account');
    const below = card('s-below', 'contact', 'Contact', [
      column('s-belowfk', 'parentcustomerid', 'Customer', { isLookup: true, targets: ['account'] }),
      column('s-belowfk2', 'ownerid', 'Owner', { isLookup: true, targets: ['systemuser'] })
    ]);

    above.x = 0; above.y = 0;
    below.x = 0; below.y = 400;
    doc.tables.push(above, below);

    const link = {
      id: 'r-stacked', schemaName: 'cs_stacked', kind: 'OneToMany', status: 'Existing',
      fromTableId: above.id, toTableId: below.id,
      referencedAttribute: 'accountid', referencingAttribute: 'parentcustomerid',
      included: true, hidden: false, waypoints: [], lookupTargets: []
    };
    doc.relationships.push(link);
    doc.settings.fieldDetail = 'AllFields';
    geometry.invalidateSizes();

    const belowRect = geometry.tableRect(below);
    const fkIndex = belowRect.rows.findIndex(row => row.column.logicalName === 'parentcustomerid');
    const fkY = belowRect.y + geometry.METRICS.headerHeight +
      fkIndex * geometry.METRICS.rowHeight + geometry.METRICS.rowHeight / 2;

    const route = geometry.routeRelationship(link, 0, 1);

    check('the fixture really is one card above the other',
      below.y > above.y + geometry.tableRect(above).height && fkIndex > 0, String(fkIndex));
    check('the many end points at the lookup row, not at the card',
      Math.abs(route.end.y - fkY) < 0.01, route.end.y + ' vs ' + fkY);

    const aboveRect = geometry.tableRect(above);
    const pkY = aboveRect.y + geometry.METRICS.headerHeight + geometry.METRICS.rowHeight / 2;
    check('and the one end points at its primary key row',
      Math.abs(route.start.y - pkY) < 0.01, route.start.y + ' vs ' + pkY);

    check('which means it leaves through the side of the card, not the bottom edge',
      route.startSide === route.endSide &&
      (route.startSide === 'left' || route.startSide === 'right'), route.startSide);

    // Round the outside of both cards: a lane between them is where the cards are.
    const laneX = route.points[1].x;
    check('the lane runs outside both cards',
      laneX > Math.max(aboveRect.x + aboveRect.width, belowRect.x + belowRect.width) ||
      laneX < Math.min(aboveRect.x, belowRect.x), String(laneX));

    check('the lane is what a drag moves, and there is no second axis to move',
      route.offsetAxis === 'x' && route.crossAxis === null,
      route.offsetAxis + '/' + route.crossAxis);

    // Outwards, away from the cards. Inwards the lane stops at their edge, which is the one thing
    // it is not allowed to cross - see the clamp in sameSideRoute.
    const outwards = route.startSide === 'right' ? 70 : -70;
    link.routeOffset = outwards;
    const pushed = geometry.routeRelationship(link, 0, 1);
    check('dragging it moves the lane and nothing else',
      Math.abs(pushed.points[1].x - (laneX + outwards)) < 0.01 &&
      pushed.start.y === route.start.y && pushed.end.y === route.end.y,
      pushed.points[1].x + ' vs ' + (laneX + outwards));

    // And never into the cards it is running beside, however far the drag goes.
    link.routeOffset = -outwards * 40;
    const jammed = geometry.routeRelationship(link, 0, 1);
    const inside = jammed.points[1].x > Math.min(aboveRect.x, belowRect.x) &&
      jammed.points[1].x < Math.max(aboveRect.x + aboveRect.width, belowRect.x + belowRect.width);
    check('and never inside the cards it runs beside, however hard it is dragged',
      !inside, String(jammed.points[1].x));

    link.routeOffset = 0;

    // A card with no columns drawn has nothing to point at, and the straight run between the two
    // edges is the better drawing for it, so that case keeps the straight run.
    doc.settings.fieldDetail = 'TablesOnly';
    geometry.invalidateSizes();

    const bare = geometry.routeRelationship(link, 0, 1);
    check('two cards showing no columns keep the straight top-to-bottom run',
      bare.startSide === 'bottom' && bare.endSide === 'top',
      bare.startSide + ' -> ' + bare.endSide);

    doc.settings.fieldDetail = 'AllFields';
    geometry.invalidateSizes();
  }

  // -----------------------------------------------------------------
  console.log('\nThe fields on a card can be put in any order');
  // -----------------------------------------------------------------
  {
    const doc = fresh('Field order');

    const table = card('f-table', 'account', 'Account', [
      column('f-a', 'cs_alpha', 'Alpha'),
      column('f-b', 'cs_beta', 'Beta'),
      column('f-c', 'cs_gamma', 'Gamma', { selected: false })
    ]);

    table.x = 0; table.y = 0;
    doc.tables.push(table);
    doc.settings.fieldDetail = 'AllFields';
    geometry.invalidateSizes();

    const names = () => geometry.visibleColumns(table).map(c => c.logicalName);

    check('the card starts in the order the rules give it',
      names().join(',') === 'accountid,name,cs_alpha,cs_beta', names().join(','));

    // Alpha to the top, ahead of the primary key. The key float is a rule about what makes a card
    // scannable; a hand-made order is a judgement about this drawing, and it wins.
    table.columnOrder = geometry.cardOrderAfterMove(table, ['cs_alpha', 'accountid', 'name', 'cs_beta']);
    geometry.invalidateSizes();

    check('a hand-made order beats the key float',
      names().join(',') === 'cs_alpha,accountid,name,cs_beta', names().join(','));

    // The hidden column keeps its place rather than being pushed to one end, so turning it back on
    // does not find it somewhere new.
    check('a column the card is not showing keeps its place in the order',
      table.columnOrder.includes('cs_gamma'), table.columnOrder.join(','));

    const gammaAt = table.columnOrder.indexOf('cs_gamma');
    table.columns.find(c => c.logicalName === 'cs_gamma').selected = true;
    geometry.invalidateSizes();

    check('and is drawn there when it comes back',
      names().indexOf('cs_gamma') === gammaAt, names().join(',') + ' / ' + gammaAt);

    table.columns.find(c => c.logicalName === 'cs_gamma').selected = false;

    // A column the order has never heard of is drawn after the ones it has, rather than being
    // dropped off the card altogether.
    table.columns.push(column('f-d', 'cs_delta', 'Delta'));
    geometry.invalidateSizes();
    check('a column added since the order was written is drawn last, not lost',
      names()[names().length - 1] === 'cs_delta', names().join(','));

    table.columns = table.columns.filter(c => c.logicalName !== 'cs_delta');
    table.columnOrder = [];
    geometry.invalidateSizes();
    check('clearing the order puts the card back the way the rules have it',
      names().join(',') === 'accountid,name,cs_alpha,cs_beta', names().join(','));
  }

  // -----------------------------------------------------------------
  console.log('\nDragging a row grip reorders the card');
  // -----------------------------------------------------------------
  {
    const doc = fresh('Row grips');

    const table = card('g-table', 'account', 'Account', [
      column('g-a', 'cs_alpha', 'Alpha'),
      column('g-b', 'cs_beta', 'Beta')
    ]);

    table.x = 100; table.y = 100;
    doc.tables.push(table);
    doc.settings.fieldDetail = 'AllFields';
    geometry.invalidateSizes();

    state.state.view = { zoom: 1, panX: 0, panY: 0 };
    state.clearSelection();
    render.render();

    const tableLayer = document.getElementById('layer-tables');
    const gripsWhenUnselected = findNode(tableLayer,
      node => node.hasAttribute && node.hasAttribute('data-row-grip'));

    check('a card nobody has selected has no grips on it', gripsWhenUnselected === null);

    state.selectOnly('tables', table.id);
    render.render();

    const gripFor = id => findNode(document.getElementById('layer-tables'),
      node => node.hasAttribute && node.getAttribute('data-row-grip') &&
              node.getAttribute('data-id') === id);

    check('selecting it puts a grip beside each row', gripFor('g-b') !== null);

    const rect = geometry.tableRect(table);
    const rowY = index => rect.y + geometry.METRICS.headerHeight +
      index * geometry.METRICS.rowHeight + geometry.METRICS.rowHeight / 2;

    const names = () => geometry.visibleColumns(table).map(c => c.logicalName);
    const before = names().join(',');

    const from = interactions.toScreen(rect.x, rowY(3));
    const to = interactions.toScreen(rect.x, rowY(0));

    pointer('pointerdown', from.x, from.y, { target: gripFor('g-b') });
    pointer('pointermove', to.x, to.y);
    pointer('pointerup', to.x, to.y);

    check('dragging the last row to the top puts it there',
      names()[0] === 'cs_beta', before + ' -> ' + names().join(','));
    check('and the rest of the card keeps its order',
      names().join(',') === 'cs_beta,accountid,name,cs_alpha', names().join(','));
    check('the reorder is one undoable step', state.canUndo());

    state.undo();
    geometry.invalidateSizes();

    check('undo puts the card back',
      geometry.visibleColumns(state.tableById('g-table')).map(c => c.logicalName).join(',') === before,
      geometry.visibleColumns(state.tableById('g-table')).map(c => c.logicalName).join(','));

    // The connector is anchored to a row, so moving the row moves the line. That is the thing the size
    // cache could get wrong: the rows come out of measureTable, so the order has to be part of what
    // that cache is keyed on.
    //
    // Everything below works off the live document rather than the objects above: undo swaps in a
    // clone, so `doc` and `table` name the diagram as it was before the drag and pushing into either
    // would build the fixture in a document nothing is drawing.
    const live = state.state.doc;
    const liveTable = state.tableById('g-table');

    const other = card('g-other', 'contact', 'Contact');
    other.x = 900; other.y = 100;
    live.tables.push(other);

    const link = {
      id: 'r-follows', schemaName: 'cs_follows', kind: 'OneToMany', status: 'Existing',
      fromTableId: other.id, toTableId: liveTable.id,
      referencedAttribute: 'contactid', referencingAttribute: 'cs_beta',
      included: true, hidden: false, waypoints: [], lookupTargets: []
    };
    live.relationships.push(link);
    geometry.invalidateSizes();

    const anchoredAt = geometry.routeRelationship(link, 0, 1).end.y;

    // Without calling invalidateSizes on purpose: the order is part of the cache key, so a card
    // reordered by anything that forgets to invalidate still draws the order it was given.
    liveTable.columnOrder = geometry.cardOrderAfterMove(liveTable,
      ['cs_beta', 'accountid', 'name', 'cs_alpha']);

    const movedTo = geometry.routeRelationship(link, 0, 1).end.y;
    check('the connector follows its row to the new place',
      Math.abs(movedTo - anchoredAt) > geometry.METRICS.rowHeight - 0.5,
      anchoredAt + ' -> ' + movedTo);

    liveTable.columnOrder = [];
    geometry.invalidateSizes();
  }

  // -----------------------------------------------------------------
  console.log('\nThe model list paints the colour the legend names');
  // -----------------------------------------------------------------
  {
    const doc = fresh('Model list colour');

    const plain = card('m-plain', 'account', 'Account');
    const painted = card('m-painted', 'contact', 'Contact');
    painted.highlight = '#0f7b8a';
    doc.tables.push(plain, painted);
    doc.settings.emphasisNames = { '#0f7b8a': 'Phase 2' };

    panelsModule.showTab('model');

    // Read off the nodes rather than the serialised markup: the shim carries an element's inline
    // style on the object and does not write it into the string, so a check on the text would pass
    // or fail for a reason that has nothing to do with the colour.
    const marks = [];
    (function walk(node) {
      for (const child of node.childNodes) {
        const classes = child.getAttribute ? (child.getAttribute('class') || '') : '';
        if (classes.includes('status-mark')) marks.push(child);
        walk(child);
      }
    })(document.getElementById('tab-model'));

    // Sorted by display name, so Account then Contact.
    const plainMark = marks[0];
    const paintedMark = marks[1];

    check('the model list has a mark for each table', marks.length === 2, String(marks.length));
    check('a table with an emphasis colour has its mark painted in it',
      paintedMark && paintedMark.style.background === '#0f7b8a',
      paintedMark && paintedMark.style.background);
    // Both, because four of the twelve emphasis colours are the same hex as a status colour and an
    // Existing table carries no badge to tell them apart with.
    check('and the mark says what the colour is called, and what the table is',
      paintedMark && paintedMark.getAttribute('title') === 'Phase 2 \u00b7 Existing',
      paintedMark && paintedMark.getAttribute('title'));
    check('a table with no emphasis colour is left to its status colour',
      plainMark && !plainMark.style.background &&
      (plainMark.getAttribute('class') || '').includes('st-existing'),
      plainMark && plainMark.getAttribute('class'));

    state.clearSelection();
  }

  // -----------------------------------------------------------------
  console.log('\nConnector drag edge cases');
  // -----------------------------------------------------------------
  {
    const pair = (title, ax, ay, bx, by) => {
      const doc = fresh(title);

      const left = card('v-left', 'account', 'Account');
      const right = card('v-right', 'contact', 'Contact', [
        column('v-rightfk', 'parentcustomerid', 'Customer', { isLookup: true, targets: ['account'] })
      ]);

      doc.tables.push(left, right);
      doc.settings.fieldDetail = 'AllFields';
      geometry.invalidateSizes();

      left.x = ax; left.y = ay;
      right.x = bx; right.y = by;

      const link = {
        id: 'r-' + title, schemaName: 'cs_' + title, kind: 'OneToMany', status: 'Existing',
        fromTableId: left.id, toTableId: right.id,
        referencedAttribute: 'accountid', referencingAttribute: 'parentcustomerid',
        included: true, hidden: false, waypoints: [], lookupTargets: []
      };
      doc.relationships.push(link);
      geometry.invalidateSizes();

      return { doc, left, right, link };
    };

    const insideAny = (point, rects) => rects.some(r =>
      point.x > r.x + 0.01 && point.x < r.x + r.width - 0.01 &&
      point.y > r.y + 0.01 && point.y < r.y + r.height - 0.01);

    // ---- a connector that runs right to left is clamped against the correct edge
    //
    // The low bound of the middle segment must be direction-corrected: going right to left, an
    // uncorrected range would start 12 units *inside* the source card and the line would leave that
    // card's left edge travelling right, back underneath it.
    {
      const { left, right, link } = pair('rightToLeft', 600, 0, 0, 120);
      const rects = [geometry.tableRect(left), geometry.tableRect(right)];

      link.routeOffset = 400;
      const route = geometry.routeRelationship(link, 0, 1);

      check('the fixture really does run right to left', route.startSide === 'left', route.startSide);
      check('a connector dragged hard right to left keeps its middle out of both cards',
        !route.points.some(p => insideAny(p, rects)), JSON.stringify(route.points));

      link.routeOffset = -400;
      const other = geometry.routeRelationship(link, 0, 1);
      check('and dragged hard the other way too',
        !other.points.some(p => insideAny(p, rects)), JSON.stringify(other.points));
    }

    // ---- cards half a unit out of line must not produce a leg that is neither horizontal nor vertical
    //
    // The level test allows half a unit, so tidy must collapse points within the same tolerance. A
    // diagonal leg gets no crossing bridge and is not bridged over, because crossingPoints only
    // recognises a horizontal one.
    {
      const { link } = pair('nearlyLevel', 0, 0, 600, 0.4);

      // At the anchors, which is what the level test measures. With a row at each end the two
      // anchors are two different rows apart and the run is not level at all, so the fixture would
      // have proved nothing about the tolerance.
      link.referencedAttribute = null;
      link.referencingAttribute = null;

      link.routeOffset = 40;
      link.routeOffsetCross = 40;
      const route = geometry.routeRelationship(link, 0, 1);

      const skew = geometry.segmentsOf(route.points).filter(s =>
        Math.abs(s.a.x - s.b.x) > 0.01 && Math.abs(s.a.y - s.b.y) > 0.01);

      check('the fixture really is a near-level side-to-side run',
        Math.abs(route.start.y - route.end.y) > 0.01 &&
        Math.abs(route.start.y - route.end.y) < 0.5,
        route.start.y + ' vs ' + route.end.y);
      check('two cards half a unit out of line still draw an orthogonal route',
        skew.length === 0, JSON.stringify(skew));
    }

    {
      const { left, right, link } = pair('nearlyLevelDown', 0, 0, 0.4, 500);
      link.routeOffset = 40;
      link.routeOffsetCross = 40;

      // Neither card shows the column at the other end, so this is the straight top-to-bottom run.
      left.columns = left.columns.filter(c => false);
      right.columns = right.columns.filter(c => false);
      geometry.invalidateSizes();

      const route = geometry.routeRelationship(link, 0, 1);
      const skew = geometry.segmentsOf(route.points).filter(s =>
        Math.abs(s.a.x - s.b.x) > 0.01 && Math.abs(s.a.y - s.b.y) > 0.01);

      check('and so does a top-to-bottom run half a unit out of line',
        route.startSide === 'bottom' && skew.length === 0,
        route.startSide + ' ' + JSON.stringify(skew));
    }

    // ---- one card dropped on top of another must not draw every leg inside them
    {
      // Far enough across to be a side-to-side run and still overlapping, which is the branch where
      // the clamp between the two cards had nothing to clamp to.
      const { left, right, link } = pair('overlapping', 0, 0, 100, 20);
      const rects = [geometry.tableRect(left), geometry.tableRect(right)];

      const route = geometry.routeRelationship(link, 0, 1);

      check('the fixture really is one card lying over the other',
        rects[1].x < rects[0].x + rects[0].width && rects[1].y < rects[0].y + rects[0].height &&
        Math.abs(rects[1].x - rects[0].x) >= Math.abs(rects[1].y - rects[0].y),
        JSON.stringify(rects));
      check('a connector between two overlapping cards goes round the outside of them',
        !route.points.some(p => insideAny(p, rects)), JSON.stringify(route.points));
    }

    // ---- an offset no drag can produce, but a hand-edited file can carry
    {
      const { link } = pair('infinite', 0, 0, 600, 200);

      link.routeOffset = Infinity;
      link.routeOffsetCross = -Infinity;

      const route = geometry.routeRelationship(link, 0, 1);
      check('an infinite offset does not reach the drawing',
        route.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)),
        JSON.stringify(route.points));

      link.routeOffset = NaN;
      link.routeOffsetCross = NaN;
      check('and neither does a NaN one',
        geometry.routeRelationship(link, 0, 1).points.every(p =>
          Number.isFinite(p.x) && Number.isFinite(p.y)));
    }

    // ---- a dead-level connector still reports the axis it is not yet using
    //
    // The axis is read once, at the moment of the press. If it were reported as null while the line
    // is still straight, a diagonal drag off a level connector would throw away half of itself.
    {
      const { link } = pair('levelRun', 0, 0, 600, 0);

      // Neither end names a column drawn on its card, so both anchors are the middle of the header
      // and the run is dead level.
      link.referencedAttribute = null;
      link.referencingAttribute = null;

      const route = geometry.routeRelationship(link, 0, 1);

      check('the fixture is a dead-level run with no offset on it',
        route.points.length === 2 && route.offsetAxis === 'y', route.offsetAxis);
      check('which still says a drag can move it along as well as across',
        route.crossAxis === 'x', String(route.crossAxis));
    }

    // ---- the drag state machine, driven for real
    {
      const { left, right, link } = pair('gestures', 0, 0, 600, 220);
      void left; void right;

      state.state.view = { zoom: 1, panX: 0, panY: 0 };
      render.render();

      const grabAt = () => {
        const route = geometry.routeRelationship(link, 0, 1);
        return interactions.toScreen(route.label.x, route.label.y);
      };

      // A second button pressed while the first is still down. Everything in onPointerDown overwrites
      // the drag, and the commit is keyed on the mode it finds there - so the first drag must be
      // committed (or abandoned) before the second begins, rather than leaving its live geometry on the
      // object with no undo entry and the diagram not marked unsaved.
      let grab = grabAt();
      pointer('pointerdown', grab.x, grab.y);
      pointer('pointermove', grab.x + 50, grab.y + 30);
      pointer('pointerdown', grab.x + 50, grab.y + 30, { button: 2 });

      check('a second press mid-drag puts the first drag back rather than abandoning it in place',
        !link.routeOffset && !link.routeOffsetCross,
        link.routeOffset + ' / ' + link.routeOffsetCross);

      pointer('pointerup', grab.x + 50, grab.y + 30, { button: 2 });

      // A pointer taken away is not a gesture finished.
      grab = grabAt();
      pointer('pointerdown', grab.x, grab.y);
      pointer('pointermove', grab.x + 60, grab.y);
      pointer('pointercancel', grab.x + 60, grab.y);

      check('a cancelled pointer puts the drag back rather than committing it',
        !link.routeOffset, String(link.routeOffset));

      // Escape, with the button still held.
      grab = grabAt();
      pointer('pointerdown', grab.x, grab.y);
      pointer('pointermove', grab.x + 60, grab.y);
      window.dispatchEvent({
        type: 'keydown', key: 'Escape', ctrlKey: false, metaKey: false, shiftKey: false,
        target: { tagName: 'DIV' }, preventDefault() {}, stopPropagation() {}
      });

      check('Escape mid-drag puts the connector back where it was',
        !link.routeOffset, String(link.routeOffset));

      pointer('pointerup', grab.x + 60, grab.y);

      check('and the release after it commits nothing',
        !link.routeOffset && !state.canUndo(),
        link.routeOffset + ' / ' + state.canUndo());

      // Ctrl+Z mid-drag replaces the document with a clone. The drag is holding ids and an origin from
      // the document that has gone, so it must be abandoned: committing would write that origin onto
      // the new document's objects and take an undo snapshot from it, so the top of the stack would
      // restore a value from the branch of history the user had just undone past.
      state.mutate('a step to undo', () => { link.routeOffset = 30; });

      // The hit test falls back to the route cache, which is filled by a render - without one the
      // press lands on empty canvas, starts a marquee, and the whole check passes for want of a
      // drag to get wrong.
      render.render();

      grab = grabAt();
      pointer('pointerdown', grab.x, grab.y);
      pointer('pointermove', grab.x + 80, grab.y);

      check('the fixture really does have a drag in flight when undo is pressed',
        Math.abs(link.routeOffset - 110) < 0.01, String(link.routeOffset));

      state.undo();
      pointer('pointerup', grab.x + 80, grab.y);

      const after = state.relationshipById(link.id);
      check('undo mid-drag drops the drag rather than committing it into the new document',
        after && !after.routeOffset && !state.canUndo(),
        after && (after.routeOffset + ' / ' + state.canUndo()));
    }

    // ---- a column the order cannot name by name
    //
    // A column with no logical or schema name must still take part in the order, so that a drag of
    // two unrelated rows does not move it to the end.
    {
      const doc = fresh('Nameless column');

      const table = card('x-table', 'account', 'Account', [
        column('x-blank', '', 'Nameless', { schemaName: '' }),
        column('x-zulu', 'cs_zulu', 'Zulu')
      ]);

      doc.tables.push(table);
      doc.settings.fieldDetail = 'AllFields';
      geometry.invalidateSizes();

      const names = () => geometry.visibleColumns(table).map(c => c.displayName);
      const before = names().join(',');

      check('the fixture has a column with no name of any kind',
        table.columns.some(c => !c.logicalName && !c.schemaName));
      check('and it has a key of its own all the same',
        geometry.columnOrderKey(table.columns.find(c => c.id === 'x-blank')) === 'x-blank',
        geometry.columnOrderKey(table.columns.find(c => c.id === 'x-blank')));

      // Swap the top two rows, which has nothing to do with the nameless one.
      const keys = geometry.visibleColumns(table).map(geometry.columnOrderKey);
      const swapped = keys.slice();
      swapped[0] = keys[1];
      swapped[1] = keys[0];

      table.columnOrder = geometry.cardOrderAfterMove(table, swapped);
      geometry.invalidateSizes();

      check('a drag of two other rows leaves a nameless column exactly where it was',
        names().indexOf('Nameless') === before.split(',').indexOf('Nameless'),
        before + ' -> ' + names().join(','));
    }

    // ---- the way back
    {
      const appSource = (await import('node:fs')).readFileSync(
        '../../src/Oliver4.DataModelDesigner/Web/js/app.js', 'utf8');

      check('a card the user has reordered offers a way back to the ordinary order',
        /Reset column order on this card/.test(appSource) &&
        /function resetColumnOrder\(/.test(appSource));
      check('and the command is only offered when there is an order to reset',
        /\(table\.columnOrder \|\| \[\]\)\.length\s*\n?\s*\?\s*\{ text: 'Reset column order/.test(appSource),
        (/[^\n]*Reset column order[^\n]*/.exec(appSource) || ['none'])[0].trim());
      check('and it is one undoable step',
        /mutate\('reset column order'/.test(appSource));
    }

    // ---- nothing that catches the mouse survives into a file
    {
      const doc = fresh('Exported card');

      const table = card('e-table', 'account', 'Account', [
        column('e-a', 'cs_alpha', 'Alpha'),
        column('e-b', 'cs_beta', 'Beta')
      ]);

      doc.tables.push(table);
      doc.settings.fieldDetail = 'AllFields';
      geometry.invalidateSizes();

      state.selectOnly('tables', table.id);
      render.render();

      const svgOut = render.buildExportSvg();

      check('the export carries no row grip', !svgOut.includes('data-row-grip'), svgOut.slice(0, 200));
      check('nor the tooltip that describes the gesture',
        !svgOut.includes('up or down the card'));
      check('nor anything else invisible', !svgOut.includes('transparent'), svgOut.slice(0, 200));

      // Belt to those braces, and a source check on purpose: every invisible node in this drawing is
      // gated on the selection or on forExport already, so there is no document that reaches the rule.
      // It is there for the next hit target added without either gate - a grip's tooltip, for one.
      const renderSource = (await import('node:fs')).readFileSync(
        '../../src/Oliver4.DataModelDesigner/Web/js/render.js', 'utf8');

      check('and the export strips a hit target drawn with a transparent fill, not only a stroke',
        /getAttribute\('fill'\) === 'transparent'\) node\.remove\(\)/.test(renderSource));
      check('and takes the tooltip off a row grip the way it does off a note tag',
        /hasAttribute\('data-note-for'\) \|\|\s*\n?\s*node\.hasAttribute\('data-row-grip'\)/.test(renderSource));
      // By logical name: the display name is only drawn when the display-name toggle is on, and it
      // is off by default.
      check('while the card itself is still drawn',
        svgOut.includes('cs_alpha') && svgOut.includes('cs_beta'), svgOut.slice(0, 300));

      state.clearSelection();
    }
  }

  // -----------------------------------------------------------------
  console.log('\nDrag, draw and pan cancellation edge cases');
  // -----------------------------------------------------------------
  {
    // ---- the direction-corrected clamp applies to both routes
    {
      const doc = fresh('Upward run');

      const below = card('u-below', 'account', 'Account');
      const above = card('u-above', 'contact', 'Contact');

      doc.tables.push(below, above);
      doc.settings.fieldDetail = 'TablesOnly';
      geometry.invalidateSizes();

      // Not the same x: two cards in a line take the level branch, which has no middle segment to
      // clamp and so proves nothing about the clamp.
      below.x = 0; below.y = 600;
      above.x = 60; above.y = 0;

      const link = {
        id: 'r-upward', schemaName: 'cs_upward', kind: 'OneToMany', status: 'Existing',
        fromTableId: below.id, toTableId: above.id,
        referencedAttribute: null, referencingAttribute: null,
        included: true, hidden: false, waypoints: [], lookupTargets: []
      };
      doc.relationships.push(link);
      geometry.invalidateSizes();

      const rects = [geometry.tableRect(below), geometry.tableRect(above)];
      const inside = point => rects.some(r =>
        point.x > r.x + 0.01 && point.x < r.x + r.width - 0.01 &&
        point.y > r.y + 0.01 && point.y < r.y + r.height - 0.01);

      link.routeOffset = 4000;
      const route = geometry.routeRelationship(link, 0, 1);

      check('the fixture really is a run drawn bottom to top with a middle segment to clamp',
        route.startSide === 'top' && route.endSide === 'bottom' && route.points.length > 2,
        route.startSide + ' ' + route.points.length + ' points');
      check('a top-to-bottom connector dragged hard keeps its middle out of both cards',
        !route.points.some(inside), JSON.stringify(route.points));

      link.routeOffset = -4000;
      check('and dragged hard the other way too',
        !geometry.routeRelationship(link, 0, 1).points.some(inside),
        JSON.stringify(geometry.routeRelationship(link, 0, 1).points));
    }

    // ---- abandoning a gesture part-way through
    {
      const doc = fresh('Gestures, second pass');

      const left = card('p-left', 'account', 'Account');
      const right = card('p-right', 'contact', 'Contact');
      left.x = 0; left.y = 0;
      right.x = 700; right.y = 0;
      doc.tables.push(left, right);
      doc.settings.fieldDetail = 'AllFields';
      geometry.invalidateSizes();

      state.state.view = { zoom: 1, panX: 0, panY: 0 };
      render.render();

      // An arrow being dragged out is a draw mode as well as a drag, so one Escape must end both - the
      // tool disarmed, the banner gone and the half-drawn arrow no longer painted.
      interactions.startDrawMode('arrow');
      pointer('pointerdown', 200, 200);
      pointer('pointermove', 320, 300);

      check('the fixture really is an arrow being dragged out',
        !!state.state.pendingArrow && interactions.isDrawing(),
        JSON.stringify(state.state.pendingArrow));

      window.dispatchEvent({
        type: 'keydown', key: 'Escape', ctrlKey: false, metaKey: false, shiftKey: false,
        target: { tagName: 'DIV' }, preventDefault() {}, stopPropagation() {}
      });

      check('one Escape takes away the half-drawn arrow and the tool with it',
        !state.state.pendingArrow && !interactions.isDrawing(),
        JSON.stringify(state.state.pendingArrow) + ' / ' + interactions.isDrawing());
      check('and nothing was committed to the diagram',
        state.state.doc.annotations.length === 0, String(state.state.doc.annotations.length));

      pointer('pointerup', 320, 300);

      // The same gesture taken away by the browser rather than by the user.
      interactions.startDrawMode('arrow');
      pointer('pointerdown', 200, 200);
      pointer('pointermove', 320, 300);
      pointer('pointercancel', 320, 300);

      check('a cancelled pointer takes the half-drawn arrow away too',
        !state.state.pendingArrow, JSON.stringify(state.state.pendingArrow));

      interactions.endDrawMode();

      // A pan is navigation rather than an edit, so an abandoned one keeps where it has got to - but
      // the document has to be told, since an abandoned gesture never reaches onPointerUp. Otherwise the
      // canvas is panned on screen while the diagram holds the old position, and the view that gets
      // saved is one nobody was looking at.
      state.state.view = { zoom: 1, panX: 0, panY: 0 };
      state.state.doc.view = { zoom: 1, panX: 0, panY: 0 };

      pointer('pointerdown', 400, 400, { button: 2 });
      pointer('pointermove', 500, 470, { button: 2 });

      window.dispatchEvent({
        type: 'keydown', key: 'Escape', ctrlKey: false, metaKey: false, shiftKey: false,
        target: { tagName: 'DIV' }, preventDefault() {}, stopPropagation() {}
      });

      check('a pan abandoned mid-gesture stays where it has got to',
        state.state.view.panX === 100 && state.state.view.panY === 70,
        JSON.stringify(state.state.view));
      check('and the diagram is told where that is',
        state.state.doc.view.panX === state.state.view.panX &&
        state.state.doc.view.panY === state.state.view.panY,
        JSON.stringify(state.state.doc.view));

      pointer('pointerup', 500, 470, { button: 2 });

      // One pointer owns the gesture. A second finger starts no drag of its own, and its release must
      // not end the first one's drag or release the capture for the wrong pointer.
      state.state.view = { zoom: 1, panX: 0, panY: 0 };
      render.render();

      const target = state.tableById('p-left');
      const before = target.x;

      // Through the card's own node: the hit test reads the element under the pointer, and its
      // fallback by proximity only knows about connectors.
      const cardNode = findNode(document.getElementById('layer-tables'),
        node => node.getAttribute && node.getAttribute('data-kind') === 'table' &&
                node.getAttribute('data-id') === 'p-left');

      check('the fixture found the card to drag', cardNode !== null);

      pointer('pointerdown', 40, 20, { pointerId: 1, target: cardNode });
      pointer('pointermove', 140, 20, { pointerId: 1 });
      pointer('pointerup', 300, 300, { pointerId: 2 });
      pointer('pointermove', 240, 20, { pointerId: 1 });
      pointer('pointerup', 240, 20, { pointerId: 1 });

      check('a release from another pointer does not end the drag this one is making',
        Math.abs(target.x - (before + 200)) < 0.01, before + ' -> ' + target.x);
    }

    // ---- the connector's own way back
    {
      const appSource = (await import('node:fs')).readFileSync(
        '../../src/Oliver4.DataModelDesigner/Web/js/app.js', 'utf8');

      check('a connector that has been dragged offers a way back to its automatic route',
        /Straighten this connector/.test(appSource) &&
        /function straightenConnector\(/.test(appSource));
      check('and it clears both offsets, not only the one that is visible',
        /mutate\('straighten connector'[\s\S]{0,200}routeOffset = 0;[\s\S]{0,80}routeOffsetCross = 0;/.test(appSource));
      check('and is only offered when there is something to straighten',
        /handRouted\(relationship\)\n\s*\? \{ text: 'Straighten this connector'/.test(appSource));
    }

    // ---- the drag starts from a number it can drag away from
    {
      const doc = fresh('Infinite origin');

      const left = card('i-left', 'account', 'Account');
      const right = card('i-right', 'contact', 'Contact');
      left.x = 0; left.y = 0;
      right.x = 700; right.y = 120;
      doc.tables.push(left, right);
      doc.settings.fieldDetail = 'AllFields';
      geometry.invalidateSizes();

      const link = {
        id: 'r-infinite', schemaName: 'cs_infinite', kind: 'OneToMany', status: 'Existing',
        fromTableId: left.id, toTableId: right.id,
        referencedAttribute: null, referencingAttribute: null,
        included: true, hidden: false, waypoints: [], lookupTargets: [],
        routeOffset: Infinity, routeOffsetCross: Infinity
      };
      doc.relationships.push(link);
      geometry.invalidateSizes();

      state.state.view = { zoom: 1, panX: 0, panY: 0 };
      render.render();

      const route = geometry.routeRelationship(link, 0, 1);
      const grab = interactions.toScreen(route.label.x, route.label.y);

      pointer('pointerdown', grab.x, grab.y);
      pointer('pointermove', grab.x + 40, grab.y + 20);
      pointer('pointerup', grab.x + 40, grab.y + 20);

      check('a connector carrying an infinite offset can be dragged to a real one',
        Number.isFinite(link.routeOffset) && Number.isFinite(link.routeOffsetCross),
        link.routeOffset + ' / ' + link.routeOffsetCross);
    }

    // ---- the inspector lists a card in the order the card is in
    {
      const doc = fresh('Inspector order');

      const table = card('n-table', 'account', 'Account', [
        column('n-a', 'cs_alpha', 'Alpha'),
        column('n-b', 'cs_beta', 'Beta')
      ]);

      doc.tables.push(table);
      doc.settings.fieldDetail = 'AllFields';
      geometry.invalidateSizes();

      table.columnOrder = geometry.cardOrderAfterMove(table,
        ['cs_beta', 'accountid', 'name', 'cs_alpha']);
      geometry.invalidateSizes();

      const inspector = await import(js + 'inspector.js');
      state.selectOnly('tables', table.id);
      inspector.refreshInspector();

      const body = new XMLSerializer().serializeToString(document.getElementById('inspector-body'));
      const order = ['Beta', 'Identifier', 'Name', 'Alpha'].map(name => body.indexOf(name));

      check('the inspector lists the columns in the order the card draws them',
        order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1])),
        order.join(','));

      inspector.hideInspector();
      state.clearSelection();
    }

    // ---- the grip marks sit in the middle of the grip
    {
      const doc = fresh('Grip marks');

      const table = card('k-table', 'account', 'Account', [
        column('k-a', 'cs_alpha', 'Alpha')
      ]);

      doc.tables.push(table);
      doc.settings.fieldDetail = 'AllFields';
      geometry.invalidateSizes();

      state.selectOnly('tables', table.id);
      render.render();

      const layer = document.getElementById('layer-tables');
      const gripRect = findNode(layer, node => node.hasAttribute &&
        node.getAttribute('rx') === '2.5' && node.hasAttribute('fill-opacity'));
      const marks = findNode(layer, node => node.hasAttribute && node.tagName === 'path' &&
        /^M -\d+(\.\d+)? [\d.]+ h 6/.test(node.getAttribute('d') || ''));

      check('the grip is drawn with a mark inside it', gripRect !== null && marks !== null);

      if (gripRect && marks) {
        const gripLeft = Number(gripRect.getAttribute('x'));
        const gripRight = gripLeft + Number(gripRect.getAttribute('width'));
        const markLeft = Number(/^M (-?[\d.]+)/.exec(marks.getAttribute('d'))[1]);
        const markRight = markLeft + 6;

        check('and the mark is centred in it rather than shoved against one edge',
          Math.abs((markLeft - gripLeft) - (gripRight - markRight)) < 0.51,
          'grip ' + gripLeft + '..' + gripRight + ', mark ' + markLeft + '..' + markRight);
      }

      state.clearSelection();
    }
  }

  uiModule.closeModal();
  state.clearSelection();
  state.state.view = { zoom: 1, panX: 0, panY: 0 };
}

// =====================================================================
// Moving the corners of a connector one at a time
// =====================================================================
//
// Both offsets move the *whole* middle of a route: the shape is two numbers, so every part of it
// that can move moves together. Moving one corner while the rest of the line stays where it is
// cannot be expressed as a pair of numbers, because keeping the line orthogonal round a corner
// that has moved in both directions means turning extra corners either side of it. So a corner is
// a *point the route passes through*, kept on the relationship, and the router works the
// connecting legs out around it.
{
  const interactions = await import(js + 'interact.js');
  const uiModule = await import(js + 'ui.js');

  const canvasNode = document.getElementById('canvas');

  interactions.initInteractions({
    onSelectionChange: () => {}, onContextMenu: () => {}, onOpenEditor: () => {},
    onConnect: () => {}, onAnnotationPlaced: () => {}
  });

  const nowhere = { closest: () => null, tagName: 'svg' };
  const pointer = (type, x, y, options) => {
    const event = Object.assign({
      type, pointerId: 1, clientX: x, clientY: y, button: 0,
      shiftKey: false, ctrlKey: false, altKey: false,
      target: nowhere,
      preventDefault() {}, stopPropagation() {}
    }, options || {});

    for (const handler of new Set(canvasNode.listeners[type] || [])) handler(event);
  };

  const findNode = (root, predicate) => {
    for (const child of root.childNodes) {
      if (predicate(child)) return child;
      const deeper = findNode(child, predicate);
      if (deeper) return deeper;
    }
    return null;
  };

  // The handles live in the overlay layer, above the cards, the front annotations and every other
  // connector's invisible hit stroke, so none of those can stand over them.
  const handleFor = (linkId, index) => findNode(document.getElementById('layer-overlay'), node =>
    node.getAttribute && node.getAttribute('data-corner') === String(index) &&
    node.getAttribute('data-id') === linkId);

  const column = (id, logicalName, displayName, extra) => Object.assign({
    id, logicalName, schemaName: logicalName, displayName,
    typeName: 'Text (100)', isPrimaryId: false, isPrimaryName: false, isLookup: false,
    targets: [], selected: true, status: 'Existing'
  }, extra || {});

  const card = (id, logicalName, displayName, columns) => ({
    id, logicalName, schemaName: displayName.replace(/\s/g, ''), displayName,
    status: 'Existing', x: 0, y: 0, collapsed: false, detailOverride: null,
    highlight: null, notes: '', alternateKeys: [], columnOrder: [],
    primaryIdAttribute: logicalName + 'id', primaryNameAttribute: 'name',
    columns: [
      column(id + 'pk', logicalName + 'id', 'Identifier', { isPrimaryId: true, typeName: 'Unique identifier' }),
      column(id + 'nm', 'name', 'Name', { isPrimaryName: true }),
      ...(columns || [])
    ]
  });

  const link = (id, from, to, extra) => Object.assign({
    id, schemaName: 'cs_' + id, kind: 'OneToMany', status: 'Existing',
    fromTableId: from, toTableId: to,
    referencedAttribute: null, referencingAttribute: null,
    included: true, hidden: false, waypoints: [], lookupTargets: []
  }, extra || {});

  const fresh = title => {
    state.setDocument(state.newDocument(title), null);
    geometry.invalidateSizes();
    return state.state.doc;
  };

  const shape = points => points.map(p => Math.round(p.x) + ',' + Math.round(p.y)).join(' ');

  /** Every leg of a route, and whether any of them is neither horizontal nor vertical. */
  const diagonals = points => geometry.segmentsOf(points).filter(seg =>
    Math.abs(seg.a.x - seg.b.x) > 0.01 && Math.abs(seg.a.y - seg.b.y) > 0.01);

  uiModule.closeModal();
  state.clearSelection();

  // -----------------------------------------------------------------
  console.log('\nPinning a route\'s own corners draws exactly the route it already drew');
  // -----------------------------------------------------------------
  //
  // The most important property of the whole feature, and the one that is invisible when it works:
  // a drag begins by pinning every corner of the drawn route, so if the router did not reproduce an
  // automatic shape from its own corners, every connector would jump the moment it was grabbed -
  // before the pointer had moved anywhere.
  {
    // Each fixture is checked where it is built, by this. fresh() replaces the whole document, so a
    // relationship kept in a list for later names tables that are no longer in it and routes to null
    // - a check that passes by never running rather than a check that passes.
    const verify = (name, rel) => {
      const before = geometry.routeRelationship(rel, 0, 1);

      check('the ' + name + ' fixture has corners to pin',
        before.corners.length >= 2 && !before.manual,
        before.corners.length + ' corners');

      check('and none of them is pinned yet',
        before.corners.every(corner => corner.waypointIndex === null));

      rel.waypoints = before.corners.map(corner => ({ x: corner.x, y: corner.y }));
      const after = geometry.routeRelationship(rel, 0, 1);

      check('pinning them redraws the ' + name + ' route point for point',
        shape(after.points) === shape(before.points),
        shape(before.points) + '  ->  ' + shape(after.points));
      check('and it knows it is hand-routed now', after.manual === true);
      check('and both ends are still exactly where they were - ' + name,
        after.start.x === before.start.x && after.start.y === before.start.y &&
        after.end.x === before.end.x && after.end.y === before.end.y);

      // Pinning a route's own corners is where hops collapse to a single leg, and a bend pushed on top
      // of the pinned point it was heading for is dropped by tidy in favour of the *untagged* copy. No
      // two corners may then sit on one pixel, or the pinned corner's handle is drawn twice: two
      // gestures in one place, one moving that corner and one inserting another next to it.
      const stacked = after.corners.filter((corner, at) => after.corners.some((other, when) =>
        when !== at && Math.abs(other.x - corner.x) < 0.01 && Math.abs(other.y - corner.y) < 0.01));

      check('and no two handles land on the same point - ' + name,
        stacked.length === 0, JSON.stringify(stacked));

      rel.waypoints = [];
    };

    // Side to side, a row at each end.
    {
      const doc = fresh('Pin side to side');
      const left = card('p-left', 'account', 'Account');
      const right = card('p-right', 'contact', 'Contact', [
        column('p-rightfk', 'parentcustomerid', 'Customer', { isLookup: true, targets: ['account'] })
      ]);
      left.x = 0; left.y = 0;
      right.x = 600; right.y = 220;
      doc.tables.push(left, right);
      doc.settings.fieldDetail = 'RelationshipFields';
      const rel = link('r-pin-side', left.id, right.id,
        { referencedAttribute: 'accountid', referencingAttribute: 'parentcustomerid' });
      doc.relationships.push(rel);
      geometry.invalidateSizes();
      verify('side to side', rel);
    }

    // The same route with a cross offset on it, which is the eight-point shape with a step at
    // each end - the one with the most corners to get wrong.
    {
      const doc = fresh('Pin stepped');
      const left = card('q-left', 'account', 'Account');
      const right = card('q-right', 'contact', 'Contact', [
        column('q-rightfk', 'parentcustomerid', 'Customer', { isLookup: true, targets: ['account'] })
      ]);
      left.x = 0; left.y = 0;
      right.x = 600; right.y = 220;
      doc.tables.push(left, right);
      doc.settings.fieldDetail = 'RelationshipFields';
      const rel = link('r-pin-step', left.id, right.id, {
        referencedAttribute: 'accountid', referencingAttribute: 'parentcustomerid',
        routeOffset: 30, routeOffsetCross: 60
      });
      doc.relationships.push(rel);
      geometry.invalidateSizes();
      verify('a route with a step at each end', rel);
    }

    // Straight down, neither card showing a column, so there is no row to point at.
    {
      const doc = fresh('Pin top to bottom');
      const above = card('v-above', 'account', 'Account');
      const below = card('v-below', 'contact', 'Contact');
      above.x = 0; above.y = 0;
      below.x = 40; below.y = 400;
      doc.tables.push(above, below);
      doc.settings.fieldDetail = 'TablesOnly';
      const rel = link('r-pin-vert', above.id, below.id);
      doc.relationships.push(rel);
      geometry.invalidateSizes();
      verify('top to bottom', rel);
    }

    // Stacked with rows to point at, so the route goes round the outside - one degree of freedom,
    // both arms at their rows.
    {
      const doc = fresh('Pin same side');
      const above = card('w-above', 'account', 'Account');
      const below = card('w-below', 'contact', 'Contact', [
        column('w-belowfk', 'parentcustomerid', 'Customer', { isLookup: true, targets: ['account'] })
      ]);
      above.x = 0; above.y = 0;
      below.x = 10; below.y = 260;
      doc.tables.push(above, below);
      doc.settings.fieldDetail = 'RelationshipFields';
      const rel = link('r-pin-same', above.id, below.id,
        { referencedAttribute: 'accountid', referencingAttribute: 'parentcustomerid' });
      doc.relationships.push(rel);
      geometry.invalidateSizes();
      verify('round the outside of two stacked cards', rel);
    }

    // A relationship from a table to itself, which is drawn as a loop off the right-hand edge.
    {
      const doc = fresh('Pin self');
      const only = card('x-self', 'account', 'Account');
      only.x = 100; only.y = 100;
      doc.tables.push(only);
      doc.settings.fieldDetail = 'TablesOnly';
      const rel = link('r-pin-self', only.id, only.id);
      doc.relationships.push(rel);
      geometry.invalidateSizes();
      verify('a self-referencing loop', rel);
    }
  }

  // -----------------------------------------------------------------
  console.log('\nA hand-placed corner is where the route turns');
  // -----------------------------------------------------------------
  //
  // These drive the router directly, which is what a hand-edited file does. Every drag in the tool
  // moves the legs of the route it is already drawing, so the lists it writes always alternate
  // horizontal and vertical - but a file can carry anything, and the shapes below are what the
  // router has to make of the awkward ones.
  {
    const doc = fresh('One corner');

    const left = card('m-left', 'account', 'Account');
    const right = card('m-right', 'contact', 'Contact', [
      column('m-rightfk', 'parentcustomerid', 'Customer', { isLookup: true, targets: ['account'] })
    ]);
    left.x = 0; left.y = 0;
    right.x = 600; right.y = 220;
    doc.tables.push(left, right);
    doc.settings.fieldDetail = 'RelationshipFields';

    const rel = link('r-one-corner', left.id, right.id,
      { referencedAttribute: 'accountid', referencingAttribute: 'parentcustomerid' });
    doc.relationships.push(rel);
    geometry.invalidateSizes();

    const before = geometry.routeRelationship(rel, 0, 1);
    const pinned = before.corners.map(corner => ({ x: corner.x, y: corner.y }));

    check('the fixture is the ordinary two-corner route', pinned.length === 2, String(pinned.length));

    const second = { x: pinned[1].x, y: pinned[1].y };
    pinned[0] = { x: pinned[0].x - 90, y: pinned[0].y - 70 };
    rel.waypoints = pinned;

    const moved = geometry.routeRelationship(rel, 0, 1);

    check('a corner off the alternating shape is still on the route where it was put',
      moved.points.some(point =>
        Math.abs(point.x - pinned[0].x) < 0.01 && Math.abs(point.y - pinned[0].y) < 0.01),
      shape(moved.points));
    check('the other corner has not moved',
      moved.points.some(point =>
        Math.abs(point.x - second.x) < 0.01 && Math.abs(point.y - second.y) < 0.01),
      shape(moved.points));
    check('neither end has moved',
      moved.start.x === before.start.x && moved.start.y === before.start.y &&
      moved.end.x === before.end.x && moved.end.y === before.end.y);
    check('every leg is still horizontal or vertical',
      diagonals(moved.points).length === 0, shape(moved.points));
    check('the first leg still leaves the card through its own side',
      Math.abs(moved.points[0].y - moved.points[1].y) < 0.01, shape(moved.points));
    check('and the last leg still arrives at the other card through its own side',
      Math.abs(moved.points[moved.points.length - 1].y - moved.points[moved.points.length - 2].y) < 0.01,
      shape(moved.points));

    // The invariant every corner gesture is built on: the drag bakes the corners as the route's
    // own points and then moves one of them by index, so a corner list that does not line up
    // one-for-one with the drawn line would move the wrong part of it.
    const lines = points => points.slice(1, -1).map(p => Math.round(p.x) + ',' + Math.round(p.y)).join(' ');

    check('and there is exactly one corner per interior point of the drawn line, in order',
      lines(moved.points) === moved.corners.map(c => Math.round(c.x) + ',' + Math.round(c.y)).join(' '),
      lines(moved.points) + '  |  ' + moved.corners.map(c => Math.round(c.x) + ',' + Math.round(c.y)).join(' '));

    // A corner pulled back past its neighbour is a leg that goes out and comes straight back. tidy
    // must ask whether the middle point lies *between* the two beside it before removing it as a
    // straight run, or the drawn line comes out unchanged and the corner's handle is left in mid-air
    // off the end of it.
    rel.waypoints = [{ x: second.x, y: before.corners[0].y }, { x: second.x - 60, y: second.y }];
    const excursion = geometry.routeRelationship(rel, 0, 1);

    check('a corner pulled back past its neighbour is still on the drawn line',
      excursion.points.some(point =>
        Math.abs(point.x - (second.x - 60)) < 0.01 && Math.abs(point.y - second.y) < 0.01),
      shape(excursion.points));
    check('and every handle is on the drawn line',
      excursion.corners.every(corner =>
        geometry.distanceToPolyline(corner, excursion.points) < 0.01),
      JSON.stringify(excursion.corners.map(c => [c.x, c.y])));

    // An automatic route can make the same shape when an offset is dragged past its clamp, and there
    // the excursion is a wrinkle in a shape nobody placed point by point, so it is tidied away.
    rel.waypoints = [];
    rel.routeOffset = 900;
    rel.routeOffsetCross = 500;

    const stretched = geometry.routeRelationship(rel, 0, 1);
    const doublesBack = stretched.points.some((point, at) => {
      if (at === 0 || at === stretched.points.length - 1) return false;
      const back = stretched.points[at - 1];
      const on = stretched.points[at + 1];
      return (Math.abs(back.x - point.x) < 0.01 && Math.abs(point.x - on.x) < 0.01 &&
              (point.y < Math.min(back.y, on.y) - 0.01 || point.y > Math.max(back.y, on.y) + 0.01)) ||
             (Math.abs(back.y - point.y) < 0.01 && Math.abs(point.y - on.y) < 0.01 &&
              (point.x < Math.min(back.x, on.x) - 0.01 || point.x > Math.max(back.x, on.x) + 0.01));
    });

    check('an automatic route dragged past its clamp is still tidied flat',
      !doublesBack, shape(stretched.points));

    rel.routeOffset = 0;
    rel.routeOffsetCross = 0;

    // One corner, and not at the height of either anchor, so the *last* hop has two legs to get in
    // the right order. Every other fixture here keeps a corner at the end anchor's own row, where
    // that hop collapses to a single leg and gets the order right whatever the rule says.
    rel.waypoints = [{ x: 300, y: -120 }];
    const single = geometry.routeRelationship(rel, 0, 1);
    const tail = single.points.slice(-2);

    check('a route with one corner well off both rows still arrives through the card\'s side',
      Math.abs(tail[0].y - tail[1].y) < 0.01, shape(single.points));
    check('and still leaves through the other card\'s side',
      Math.abs(single.points[0].y - single.points[1].y) < 0.01, shape(single.points));
    check('and turns a corner at the point that was pinned',
      single.points.some(point =>
        Math.abs(point.x - 300) < 0.01 && Math.abs(point.y + 120) < 0.01), shape(single.points));

    // One corner at the height of the anchor it comes from, so the hop that reaches it is a single
    // horizontal leg and the route arrives at it travelling the way the end card's side faces. Two
    // legs can then both turn there and come in to the card correctly, and taking three anyway
    // would set off along the leg that got there - leaving the corner on a straight run, where tidy
    // drops it and the route stops passing through it at all.
    rel.waypoints = [{ x: 300, y: single.start.y }];
    const level = geometry.routeRelationship(rel, 0, 1);
    const at = level.points.findIndex(point => Math.abs(point.x - 300) < 0.01 &&
      Math.abs(point.y - single.start.y) < 0.01);

    check('a corner level with the anchor it comes from is a corner, not a point on a straight run',
      at > 0 && at < level.points.length - 1 &&
      Math.abs(level.points[at - 1].y - level.points[at].y) < 0.01 &&
      Math.abs(level.points[at + 1].x - level.points[at].x) < 0.01,
      shape(level.points));
    check('and the route still arrives through the other card\'s side',
      Math.abs(level.points[level.points.length - 1].y - level.points[level.points.length - 2].y) < 0.01,
      shape(level.points));

    rel.waypoints = [];
  }

  // -----------------------------------------------------------------
  console.log('\nA corner that is not a pair of finite numbers is not a corner');
  // -----------------------------------------------------------------
  //
  // The same guard both offsets carry, for the same reason: a corner is a point on the drawn route,
  // so an infinite one would reach documentBounds and hand Fit and every picture export a drawing
  // with no finite extent. No drag can produce one; a hand-edited file can.
  {
    const doc = fresh('Rotten corners');

    const left = card('z-left', 'account', 'Account');
    const right = card('z-right', 'contact', 'Contact');
    left.x = 0; left.y = 0;
    right.x = 700; right.y = 120;
    doc.tables.push(left, right);
    doc.settings.fieldDetail = 'TablesOnly';

    const rel = link('r-rotten', left.id, right.id);
    doc.relationships.push(rel);
    geometry.invalidateSizes();

    const clean = geometry.routeRelationship(rel, 0, 1);

    rel.waypoints = [null, { x: Infinity, y: 10 }, { x: 10, y: NaN }, { x: '40', y: '80' }];
    const guarded = geometry.routeRelationship(rel, 0, 1);

    check('a null, an infinite and a NaN corner are all dropped',
      guarded.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)),
      shape(guarded.points));
    check('and the one readable corner is still honoured, string coordinates and all',
      guarded.points.some(point => Math.abs(point.x - 40) < 0.01) &&
      guarded.corners.some(corner => corner.waypointIndex === 0 &&
        Math.abs(corner.x - 40) < 0.01 && Math.abs(corner.y - 80) < 0.01),
      shape(guarded.points));

    rel.waypoints = [{ x: Infinity, y: Infinity }];
    check('a connector whose only corner is unusable goes back to its automatic route',
      shape(geometry.routeRelationship(rel, 0, 1).points) === shape(clean.points));

    rel.waypoints = 'not a list';
    check('and so does one whose corners are not a list at all',
      shape(geometry.routeRelationship(rel, 0, 1).points) === shape(clean.points));

    rel.waypoints = [];
  }

  // -----------------------------------------------------------------
  console.log('\nDragging a corner moves the legs that meet at it');
  // -----------------------------------------------------------------
  //
  // A corner drag moves the two legs meeting at it and nothing else, rather than dragging the line
  // out through a new bend - and a leg held at one of the two anchors does not move at all, which is
  // why a corner next to a card slides one way only.
  {
    const interactions = await import(js + 'interact.js');
    const uiModule = await import(js + 'ui.js');

    const canvasNode = document.getElementById('canvas');

    interactions.initInteractions({
      onSelectionChange: () => {}, onContextMenu: () => {}, onOpenEditor: () => {},
      onConnect: () => {}, onAnnotationPlaced: () => {}
    });

    const nowhere = { closest: () => null, tagName: 'svg' };
    const pointer = (type, x, y, options) => {
      const event = Object.assign({
        type, pointerId: 1, clientX: x, clientY: y, button: 0,
        shiftKey: false, ctrlKey: false, altKey: false,
        target: nowhere,
        preventDefault() {}, stopPropagation() {}
      }, options || {});

      for (const handler of new Set(canvasNode.listeners[type] || [])) handler(event);
    };

    const findNode = (root, predicate) => {
      for (const child of root.childNodes) {
        if (predicate(child)) return child;
        const deeper = findNode(child, predicate);
        if (deeper) return deeper;
      }
      return null;
    };

    // The handles live in the overlay layer, above the cards, the front annotations and every other
    // connector's invisible hit stroke, so none of those can stand over them.
    const handleFor = (linkId, index) => findNode(document.getElementById('layer-overlay'), node =>
      node.getAttribute && node.getAttribute('data-corner') === String(index) &&
      node.getAttribute('data-id') === linkId);

    const build = (title, extra) => {
      const doc = fresh(title);

      const left = card('h-left', 'account', 'Account');
      const right = card('h-right', 'contact', 'Contact', [
        column('h-rightfk', 'parentcustomerid', 'Customer', { isLookup: true, targets: ['account'] })
      ]);
      left.x = 0; left.y = 0;
      right.x = 600; right.y = 220;
      doc.tables.push(left, right);
      doc.settings.fieldDetail = 'RelationshipFields';

      const rel = link('r-handle', left.id, right.id, Object.assign({
        referencedAttribute: 'accountid', referencingAttribute: 'parentcustomerid'
      }, extra || {}));
      doc.relationships.push(rel);
      geometry.invalidateSizes();

      state.state.view = { zoom: 1, panX: 0, panY: 0 };
      state.selectOnly('relationships', rel.id);
      render.render();

      return rel;
    };

    const drag = (rel, index, dx, dy, options) => {
      state.selectOnly('relationships', rel.id);
      render.render();

      const route = geometry.routeRelationship(rel, 0, 1);
      const corner = route.corners[index];
      const handle = handleFor(rel.id, index);
      const at = interactions.toScreen(corner.x, corner.y);
      const held = Object.assign({ target: handle }, options || {});

      pointer('pointerdown', at.x, at.y, held);
      pointer('pointermove', at.x + dx, at.y + dy, held);
      pointer('pointerup', at.x + dx, at.y + dy, held);

      // Checked after *every* drag in this block, because a control that vanishes is the one kind
      // of defect a fixture aimed somewhere else will never notice. A leg dragged all the way onto
      // the card it ends on has no length left; tidy drops it, the two corners either side collapse
      // into one with a card at both ends, and a connector halfway through being shaped loses every
      // handle it had.
      state.selectOnly('relationships', rel.id);
      render.render();

      const left = geometry.routeRelationship(rel, 0, 1);
      check('and the line still has a handle to carry on with',
        (left.corners || []).some(entry => entry.carryX || entry.carryY),
        JSON.stringify((left.corners || []).map(c => [c.carryX, c.carryY])));

      return { route, corner, handle };
    };

    uiModule.closeModal();
    state.clearSelection();

    // ---- which way a corner can go, and what goes with it
    {
      const rel = build('Freedom');
      const route = geometry.routeRelationship(rel, 0, 1);

      check('the fixture is the ordinary two-corner route', route.corners.length === 2,
        String(route.corners.length));

      // Out of the first card's side, up or down, into the second card's side. Both legs touching a
      // card are held on the column the relationship points at, so neither corner can move
      // vertically - and the leg between them is the one both of them carry.
      check('a corner next to a card can only slide along the card\'s own face',
        !route.corners[0].carryY && !route.corners[1].carryY,
        JSON.stringify(route.corners.map(c => [c.carryX, c.carryY])));
      check('and moving it carries the leg to the corner beyond it',
        JSON.stringify(route.corners[0].carryX) === '[1]' &&
        JSON.stringify(route.corners[1].carryX) === '[0]',
        JSON.stringify(route.corners.map(c => c.carryX)));

      const { corner } = drag(rel, 0, -92, -72);

      check('dragging it moves both ends of that leg together',
        rel.waypoints.length === 2 &&
        Math.abs(rel.waypoints[0].x - rel.waypoints[1].x) < 0.01,
        JSON.stringify(rel.waypoints));
      check('and takes it to where the pointer went, along the axis it can travel on',
        Math.abs(rel.waypoints[0].x - (corner.x - 92)) <= 2.01,
        'from ' + corner.x + ' by -92 -> ' + rel.waypoints[0].x);
      check('and does not move it on the axis a card is holding',
        Math.abs(rel.waypoints[0].y - corner.y) < 0.01 &&
        Math.abs(rel.waypoints[1].y - geometry.routeRelationship(rel, 0, 1).end.y) < 0.01,
        JSON.stringify(rel.waypoints));

      const after = geometry.routeRelationship(rel, 0, 1);

      check('the line has the same number of bends it started with - none were added',
        after.corners.length === 2, String(after.corners.length));
      check('and both ends are still on their own columns',
        after.start.y === route.start.y && after.end.y === route.end.y);
      check('and it is one undoable step', state.canUndo());

      state.undo();
      check('undo puts the automatic route back',
        (state.relationshipById('r-handle').waypoints || []).length === 0);
    }

    // ---- a leg dragged hard at the card it ends on
    {
      const rel = build('Hard against the card');
      const route = geometry.routeRelationship(rel, 0, 1);
      const reach = route.end.x - route.corners[1].x;

      check('the fixture has a leg that can be dragged onto the far card', reach > 40,
        String(reach));

      drag(rel, 1, reach + 5, 0);

      const after = geometry.routeRelationship(rel, 0, 1);

      check('the leg stops short of the card rather than collapsing onto it',
        after.corners.length === route.corners.length,
        route.corners.length + ' -> ' + after.corners.length + ' ' + shape(after.points));
      check('and the last leg still has some length to it',
        Math.abs(after.points[after.points.length - 1].x -
          after.points[after.points.length - 2].x) >= 11.99,
        shape(after.points));

      // The same at the other end: a route drawn right to left starts at the card's own x, so the
      // first leg is the one that collapses.
      const doc = state.state.doc;
      const backwards = build('Right to left');
      state.tableById('h-left').x = 700;
      state.tableById('h-right').x = 0;
      geometry.invalidateSizes();
      state.selectOnly('relationships', backwards.id);
      render.render();

      const other = geometry.routeRelationship(backwards, 0, 1);
      drag(backwards, 0, other.start.x - other.corners[0].x - 5, 0);

      const settled = geometry.routeRelationship(backwards, 0, 1);
      check('and a route drawn the other way round keeps its first leg too',
        settled.corners.length === other.corners.length &&
        Math.abs(settled.points[0].x - settled.points[1].x) >= 11.99,
        shape(settled.points));
    }

    // ---- three points in a line are one leg, not two
    {
      // A run of points sharing a coordinate is a single leg with a redundant point on it. Moving
      // two of the three would bend it - and if one of the three is an anchor, moving any of them
      // takes an end off the column it points at and the router turns a new bend to get back.
      const rel = build('A run');
      const route = geometry.routeRelationship(rel, 0, 1);

      rel.waypoints = [
        { x: route.start.x + 110, y: route.start.y },
        { x: route.start.x + 70, y: route.start.y },
        { x: route.start.x + 210, y: route.start.y }
      ];

      state.selectOnly('relationships', rel.id);
      render.render();

      const run = geometry.routeRelationship(rel, 0, 1);
      const middle = run.corners.findIndex(corner =>
        Math.abs(corner.x - (route.start.x + 70)) < 0.01);

      check('the fixture really is a run along the anchor\'s own row', middle > 0,
        shape(run.points));
      check('a point on a run that reaches an anchor cannot be moved across it',
        !run.corners[middle].carryY, JSON.stringify(run.corners[middle]));
      check('nor along it, so it has no handle and cannot bend the line at all',
        !run.corners[middle].carryX && !handleFor(rel.id, middle),
        JSON.stringify(run.corners[middle]));

      // The same run, clear of both anchors: now the whole of it moves, and all of it together.
      rel.waypoints = [
        { x: route.start.x + 60, y: route.start.y },
        { x: route.start.x + 60, y: route.start.y + 90 },
        { x: route.start.x + 160, y: route.start.y + 90 },
        { x: route.start.x + 120, y: route.start.y + 90 },
        { x: route.start.x + 240, y: route.start.y + 90 }
      ];

      state.selectOnly('relationships', rel.id);
      render.render();

      const clear = geometry.routeRelationship(rel, 0, 1);
      const inner = clear.corners.findIndex(corner =>
        Math.abs(corner.x - (route.start.x + 120)) < 0.01);

      check('a point on a run clear of both anchors moves across it', inner > 0 &&
        !!clear.corners[inner].carryY, JSON.stringify(clear.corners[inner]));
      check('and carries every other point on that run with it - all three of them',
        clear.corners[inner].carryY.length === 3,
        JSON.stringify(clear.corners[inner].carryY));

      const wasBends = clear.corners.length;
      drag(rel, inner, 0, 80);

      check('so dragging it adds no bend to the line',
        geometry.routeRelationship(rel, 0, 1).corners.length <= wasBends,
        wasBends + ' -> ' + geometry.routeRelationship(rel, 0, 1).corners.length);

      rel.waypoints = [];
    }

    // ---- a corner with a corner on each side of it moves both ways
    {
      // A cross offset gives the stepped shape: a short leg out of each card, then the middle of
      // the route carried across. The corners in the middle of that have a corner on either side
      // rather than a card, so both of their legs can move.
      const rel = build('Both ways', { routeOffset: 30, routeOffsetCross: 90 });
      const route = geometry.routeRelationship(rel, 0, 1);
      const free = route.corners.findIndex(corner => corner.carryX && corner.carryY);

      check('the fixture has a corner with a corner on both sides of it', free > 0,
        JSON.stringify(route.corners.map(c => [c.carryX, c.carryY])));

      const corner = route.corners[free];
      const neighbours = route.corners.map(c => ({ x: c.x, y: c.y }));

      drag(rel, free, 40, 40);

      const after = geometry.routeRelationship(rel, 0, 1);

      check('it moves on both axes', Math.abs(after.corners[free].x - (corner.x + 40)) <= 2.01 &&
        Math.abs(after.corners[free].y - (corner.y + 40)) <= 2.01,
        JSON.stringify(after.corners[free]));
      check('and still adds no bend to the line',
        after.corners.length === route.corners.length,
        route.corners.length + ' -> ' + after.corners.length);
      check('and each leg carried exactly one neighbour with it',
        after.corners.filter((entry, at) =>
          Math.abs(entry.x - neighbours[at].x) > 0.01 ||
          Math.abs(entry.y - neighbours[at].y) > 0.01).length === 3,
        JSON.stringify(after.corners.map((c, at) =>
          Math.round(c.x - neighbours[at].x) + ',' + Math.round(c.y - neighbours[at].y))));
      check('every leg is still horizontal or vertical',
        diagonals(after.points).length === 0, shape(after.points));
    }

    // ---- a corner held at both ends has no handle at all
    {
      const rel = build('Nothing to move');
      const route = geometry.routeRelationship(rel, 0, 1);

      // A corner whose legs both end at a card cannot move either of them. A handle there would be
      // a control that does nothing, so there is not one.
      rel.waypoints = [{ x: route.end.x, y: route.start.y }];
      state.selectOnly('relationships', rel.id);
      render.render();

      const only = geometry.routeRelationship(rel, 0, 1);

      check('the fixture really is a route with one corner between the two cards',
        only.corners.length === 1, String(only.corners.length));
      check('a corner with a card at both ends of it can move neither leg',
        !only.corners[0].carryX && !only.corners[0].carryY,
        JSON.stringify(only.corners[0]));
      check('and is given no handle', !handleFor(rel.id, 0));

      // The drag refuses it as well, which no click can reach while the handle is not drawn - but a
      // handle is drawn from the route at the time of the *render*, and anything that repaints between
      // the draw and the press can take its freedom away. Pinned as a source check.
      const interactSource = (await import('node:fs')).readFileSync(
        '../../src/Oliver4.DataModelDesigner/Web/js/interact.js', 'utf8');

      check('and a press on a stale handle for one starts no drag',
        /if \(!corner\.carryX && !corner\.carryY\) return null;/.test(interactSource));

      rel.waypoints = [];
    }

    // ---- taking a bend out
    {
      const rel = build('Remove a bend', { routeOffset: 30, routeOffsetCross: 90 });
      const route = geometry.routeRelationship(rel, 0, 1);

      check('the fixture is a stepped route with bends to spare', route.corners.length >= 4,
        String(route.corners.length));

      const removable = route.corners
        .map((corner, at) => geometry.cornersWithout(rel, 0, 1, at) === null ? null : at)
        .filter(at => at !== null);

      check('some of its bends can be taken out', removable.length > 0,
        JSON.stringify(removable));

      const reduced = geometry.cornersWithout(rel, 0, 1, removable[0]);
      rel.waypoints = reduced;
      rel.routeOffset = 0;
      rel.routeOffsetCross = 0;

      const after = geometry.routeRelationship(rel, 0, 1);

      check('and taking one out leaves the line with fewer bends',
        after.corners.length < route.corners.length,
        route.corners.length + ' -> ' + after.corners.length);
      check('while both ends stay on their columns',
        after.start.y === route.start.y && after.end.y === route.end.y);
      check('and every leg is still horizontal or vertical',
        diagonals(after.points).length === 0, shape(after.points));
    }

    // ---- the bends that cannot go are not offered
    {
      const rel = build('Structural');
      const route = geometry.routeRelationship(rel, 0, 1);

      // Out of one card's side and into another's at a different height: the line has to turn
      // twice and no route exists with fewer, so taking either corner out only puts it back
      // somewhere else. Offered, the menu item would appear to do nothing.
      check('neither corner of the plain two-bend route can be taken out',
        geometry.cornersWithout(rel, 0, 1, 0) === null &&
        geometry.cornersWithout(rel, 0, 1, 1) === null);

      check('and an index that is not a corner is refused too',
        geometry.cornersWithout(rel, 0, 1, 7) === null &&
        geometry.cornersWithout(rel, 0, 1, -1) === null);

      // Null is what the menu hands it when the right-click did not land on a handle at all, and null is
      // neither less than zero nor past the end: unguarded it would fall through to the pairs, where
      // [null, 1] means "take corner 1 out".
      const noIndex = build('Null index', { routeOffset: 30, routeOffsetCross: 90 });
      check('and so is no index at all',
        geometry.cornersWithout(noIndex, 0, 1, null) === null &&
        geometry.cornersWithout(noIndex, 0, 1, undefined) === null &&
        geometry.cornersWithout(noIndex, 0, 1, 1.5) === null);

      // The check above passes on every fixture this suite can build even without the guard, because
      // null survives the range test and then falls through to a pair that removes a corner which was
      // not going to reduce the line anyway. So the guard itself is pinned in the source: it is one
      // router change away from being the difference between refusing and removing corner 1.
      const geometrySource = (await import('node:fs')).readFileSync(
        '../../src/Oliver4.DataModelDesigner/Web/js/geometry.js', 'utf8');

      check('and the index is required to be a whole number, not merely in range',
        /if \(!Number\.isInteger\(index\) \|\| index < 0/.test(geometrySource));

      // Taking the last bend anybody moved out hands the connector back to following its cards,
      // rather than leaving it carrying a list that draws the automatic route anyway.
      const stepped = build('Back to automatic', { routeOffset: 30, routeOffsetCross: 90 });
      const shape0 = shape(geometry.routeRelationship(stepped, 0, 1).points);
      stepped.waypoints = geometry.routeRelationship(stepped, 0, 1).corners
        .map(corner => ({ x: corner.x, y: corner.y }));

      check('the baked corners draw the same line the offsets did',
        shape(geometry.routeRelationship(stepped, 0, 1).points) === shape0);
    }

    // ---- Shift, and the right-click menu, take the bend out
    {
      const rel = build('Shift removes', { routeOffset: 30, routeOffsetCross: 90 });
      const route = geometry.routeRelationship(rel, 0, 1);
      const spare = route.corners.findIndex((corner, at) =>
        geometry.cornersWithout(rel, 0, 1, at) !== null);

      check('the fixture has a bend that can go', spare >= 0, String(spare));

      drag(rel, spare, 40, 40, { shiftKey: true });

      const after = geometry.routeRelationship(rel, 0, 1);

      check('Shift while dragging a corner takes that bend out instead of moving it',
        after.corners.length < route.corners.length,
        route.corners.length + ' -> ' + after.corners.length);
      check('and it is one undoable step', state.canUndo());

      check('and clears the two offsets the corners now carry, as the menu item does',
        (rel.waypoints || []).length && !rel.routeOffset && !rel.routeOffsetCross,
        rel.routeOffset + ' / ' + rel.routeOffsetCross);

      state.undo();
      check('undo puts the bend back',
        geometry.routeRelationship(state.relationshipById('r-handle'), 0, 1).corners.length ===
          route.corners.length);

      // The same gesture on a bend the route cannot do without leaves it exactly where it is.
      const plain = build('Shift on a structural bend');
      const was = state.canUndo();
      drag(plain, 0, 40, 40, { shiftKey: true });

      check('Shift on a bend that cannot go does nothing at all',
        (plain.waypoints || []).length === 0 && !plain.routeOffset, JSON.stringify(plain.waypoints));
      check('and writes no undo step', state.canUndo() === was);
    }

    // ---- Shift-click, with no drag at all
    {
      const rel = build('Shift click', { routeOffset: 30, routeOffsetCross: 90 });
      const route = geometry.routeRelationship(rel, 0, 1);
      const spare = route.corners.findIndex((corner, at) =>
        geometry.cornersWithout(rel, 0, 1, at) !== null);

      const at = interactions.toScreen(route.corners[spare].x, route.corners[spare].y);
      const handle = handleFor(rel.id, spare);

      pointer('pointerdown', at.x, at.y, { target: handle, shiftKey: true });
      pointer('pointerup', at.x, at.y, { target: handle, shiftKey: true });

      check('Shift-clicking a bend that can go takes it out without a drag',
        geometry.routeRelationship(rel, 0, 1).corners.length < route.corners.length,
        JSON.stringify(rel.waypoints));

      // On a bend that cannot go, the gesture the user is making is the ordinary one of taking the
      // connector out of a selection - which is what it would have been a few pixels further along
      // the same line.
      const plain = build('Shift click structural');
      const spot = interactions.toScreen(
        geometry.routeRelationship(plain, 0, 1).corners[0].x,
        geometry.routeRelationship(plain, 0, 1).corners[0].y);

      check('the fixture starts with the connector selected',
        state.state.selection.relationships.has(plain.id));

      pointer('pointerdown', spot.x, spot.y, { target: handleFor(plain.id, 0), shiftKey: true });
      pointer('pointerup', spot.x, spot.y, { target: handleFor(plain.id, 0), shiftKey: true });

      check('Shift-clicking one that cannot takes the line out of the selection instead',
        !state.state.selection.relationships.has(plain.id));

      state.selectOnly('relationships', plain.id);
      render.render();

      const again = interactions.toScreen(
        geometry.routeRelationship(plain, 0, 1).corners[0].x,
        geometry.routeRelationship(plain, 0, 1).corners[0].y);

      // Ctrl does not. It is the fine-adjustment modifier for this very drag, and the guide says so, so
      // a press with it held has to stay with the corner.
      pointer('pointerdown', again.x, again.y, { target: handleFor(plain.id, 0), ctrlKey: true });
      pointer('pointerup', again.x, again.y, { target: handleFor(plain.id, 0), ctrlKey: true });

      check('and Ctrl-clicking leaves the selection alone, because Ctrl is fine adjustment',
        state.state.selection.relationships.has(plain.id));
      check('and neither wrote any routing',
        (plain.waypoints || []).length === 0 && !plain.routeOffset);
    }

    // ---- the menu belongs to the connector the handle belongs to
    {
      const doc = fresh('Two lines');

      const left = card('p-left', 'account', 'Account');
      const right = card('p-right', 'contact', 'Contact', [
        column('p-a', 'parentcustomerid', 'Customer', { isLookup: true, targets: ['account'] }),
        column('p-b', 'cs_secondary', 'Secondary', { isLookup: true, targets: ['account'] })
      ]);
      left.x = 0; left.y = 0;
      right.x = 600; right.y = 220;
      doc.tables.push(left, right);
      doc.settings.fieldDetail = 'AllFields';

      const one = link('r-one', left.id, right.id,
        { referencedAttribute: 'accountid', referencingAttribute: 'parentcustomerid' });
      const two = link('r-two', left.id, right.id,
        { referencedAttribute: 'accountid', referencingAttribute: 'cs_secondary' });
      doc.relationships.push(one, two);
      geometry.invalidateSizes();

      // Zoomed out, which is where this feature is used. The hit test's tolerance is in world
      // units, so at 0.35x it is wide enough to swallow the connector next door - and the handle's
      // own connector is the only one that can be right.
      state.state.view = { zoom: 0.35, panX: 0, panY: 0 };
      state.selectOnly('relationships', two.id);
      render.render();

      const route = geometry.routeRelationship(two, 1, 2);
      const handle = handleFor(two.id, 0);

      check('the fixture draws a handle for the second of two parallel connectors', !!handle);

      let menuFor = null;
      interactions.initInteractions({
        onSelectionChange: () => {}, onOpenEditor: () => {}, onConnect: () => {},
        onAnnotationPlaced: () => {},
        onContextMenu: (event, hit) => { menuFor = hit; }
      });

      const at = interactions.toScreen(route.corners[0].x, route.corners[0].y);
      const menuEvent = {
        type: 'contextmenu', clientX: at.x, clientY: at.y,
        target: handle || nowhere,
        preventDefault() {}, stopPropagation() {}
      };

      for (const handler of new Set(canvasNode.listeners.contextmenu || [])) handler(menuEvent);

      check('right-clicking its handle opens the menu for that connector, not the one beside it',
        menuFor && menuFor.id === two.id, JSON.stringify(menuFor));
      check('and leaves it selected rather than swapping the selection',
        state.state.selection.relationships.has(two.id));

      state.state.view = { zoom: 1, panX: 0, panY: 0 };
      interactions.initInteractions({
        onSelectionChange: () => {}, onContextMenu: () => {}, onOpenEditor: () => {},
        onConnect: () => {}, onAnnotationPlaced: () => {}
      });
    }

    // ---- the menu item, and the command behind it
    {
      const appSource = (await import('node:fs')).readFileSync(
        '../../src/Oliver4.DataModelDesigner/Web/js/app.js', 'utf8');

      check('the connector menu offers to remove a bend',
        /text: 'Remove this bend'/.test(appSource) && /function removeBend\(/.test(appSource));
      check('and only when that bend can go',
        /bend !== null\n\s*\? \{ text: 'Remove this bend'/.test(appSource));
      check('and only for a handle belonging to the connector whose menu it is',
        /if \(handle\.getAttribute\('data-id'\) !== relationshipId\) return null;/.test(appSource));
      check('and the answer is worked out once, not once per closure',
        /const bend = bendUnderPointer\(event, relationshipId\);/.test(appSource) &&
        (appSource.match(/bendUnderPointer\(/g) || []).length === 2);
      check('and the command asks the router the same question before it writes anything',
        /const reduced = cornersWithout\([\s\S]{0,120}if \(reduced === null\) return;/.test(appSource));
      check('and clears the two offsets, which the corners now carry',
        /mutate\('remove bend'[\s\S]{0,700}relationship\.routeOffset = 0;/.test(appSource));
      check('straightening a connector still clears the corners as well as the offsets',
        /mutate\('straighten connector'[\s\S]{0,400}relationship\.waypoints = \[\];/.test(appSource));
      check('and the menu item is offered for a connector whose corners were moved',
        /function handRouted\([\s\S]{0,300}relationship\.waypoints\) && relationship\.waypoints\.length/.test(appSource));
    }

    // ---- a handle is a control of the selection, like every other grip
    {
      const rel = build('Unselected');
      check('a selected connector has handles', !!handleFor(rel.id, 0));

      state.clearSelection();
      render.render();

      check('and a connector nobody has selected has none', !handleFor(rel.id, 0));

      // A path highlight fades everything that is not on the path back to 45%, connectors included.
      // Handles in the overlay do not inherit that from the connector's group, so they must be faded
      // explicitly or a faded line keeps full-strength handles standing on it.
      state.selectOnly('relationships', rel.id);
      state.state.highlightPath = { tables: new Set(), relationships: new Set() };
      render.render();

      check('nor one the current path highlight has faded back', !handleFor(rel.id, 0));

      state.state.highlightPath = null;
      render.render();
      check('and they come back when the highlight goes', !!handleFor(rel.id, 0));
    }

    // ---- the handles are screen-sized, not diagram-sized
    {
      const rel = build('Zoomed out');
      const route = geometry.routeRelationship(rel, 0, 1);

      const full = Number(handleFor(rel.id, 0).getAttribute('width'));

      state.state.view = { zoom: 0.25, panX: 0, panY: 0 };
      render.render();
      const small = Number(handleFor(rel.id, 0).getAttribute('width'));

      check('the corner target grows as the canvas shrinks, so it stays the same size on screen',
        Math.abs(small * 0.25 - full) < 0.5, full + ' at 100%, ' + small + ' at 25%');
      check('and the handle is still on the corner it belongs to',
        Math.abs(Number(handleFor(rel.id, 0).getAttribute('x')) + small / 2 - route.corners[0].x) < 0.6);

      // The cursor says which way this one goes, because a corner beside a card goes one way only
      // and a handle that ignores half of every drag has to say so before the drag, not during it.
      check('and its cursor says which way it can be dragged',
        /ew-resize/.test(handleFor(rel.id, 0).getAttribute('style')),
        handleFor(rel.id, 0).getAttribute('style'));

      state.state.view = { zoom: 1, panX: 0, panY: 0 };
    }

    // ---- the snap
    {
      const rel = build('Snap');
      const { corner } = drag(rel, 0, 30, 0);

      // Snapped like a card is: the position lands on the grid, whatever the corner's own offset
      // from it was when it was picked up. Rounding the distance travelled instead would carry that
      // offset forever, and two corners that started out of step could never be lined up.
      check('a corner drag puts the leg on the four-unit grid, wherever it started',
        rel.waypoints[0].x % 4 === 0 && rel.waypoints[1].x % 4 === 0,
        'from ' + corner.x + ' -> ' + JSON.stringify(rel.waypoints));
      check('and within half a step of where the pointer left it',
        Math.abs(rel.waypoints[0].x - (corner.x + 30)) <= 2.01, JSON.stringify(rel.waypoints[0]));

      const fine = build('Fine');
      const grabbed = drag(fine, 0, 30, 0, { ctrlKey: true });

      check('and Ctrl takes it down to a single unit, like every other drag on this canvas',
        Math.abs(fine.waypoints[0].x - (grabbed.corner.x + 30)) <= 0.51 &&
        fine.waypoints[0].x % 1 === 0,
        'from ' + grabbed.corner.x + ' -> ' + JSON.stringify(fine.waypoints[0]));

      // Three screen pixels makes a drag; at anything above about 1.3x zoom that is less than half a
      // snap, so the gesture can travel while the corner does not. Such a drag must not commit: it
      // would pin the whole route to the shape it already had - an undo step that undoes nothing, and a
      // connector that has quietly stopped following its cards.
      const rel2 = build('Slip');
      state.state.view = { zoom: 2, panX: 0, panY: 0 };
      render.render();

      const slipRoute = geometry.routeRelationship(rel2, 0, 1);
      const slipAt = interactions.toScreen(slipRoute.corners[0].x, slipRoute.corners[0].y);
      const before = state.canUndo();

      pointer('pointerdown', slipAt.x, slipAt.y, { target: handleFor(rel2.id, 0) });
      pointer('pointermove', slipAt.x + 3, slipAt.y + 1, { target: handleFor(rel2.id, 0) });
      pointer('pointerup', slipAt.x + 3, slipAt.y + 1, { target: handleFor(rel2.id, 0) });

      check('a slip too small to move a corner leaves the connector automatic',
        (rel2.waypoints || []).length === 0 && !rel2.routeOffset && !rel2.routeOffsetCross,
        JSON.stringify(rel2.waypoints));
      check('and writes no undo step', state.canUndo() === before);

      // The same slip on a connector that is *already* hand-routed. The drag bakes the whole drawn route
      // and would write it back unchanged, so it must not mark the file unsaved or push an undo step
      // that undoes nothing.
      rel2.waypoints = [{ x: 300, y: 40 }];
      state.selectOnly('relationships', rel2.id);
      render.render();

      const routed = geometry.routeRelationship(rel2, 0, 1);
      const held = routed.corners.findIndex(corner => corner.carryX || corner.carryY);
      const spot = interactions.toScreen(routed.corners[held].x, routed.corners[held].y);
      const steps = state.canUndo();

      pointer('pointerdown', spot.x, spot.y, { target: handleFor(rel2.id, held) });
      pointer('pointermove', spot.x + 3, spot.y + 1, { target: handleFor(rel2.id, held) });
      pointer('pointerup', spot.x + 3, spot.y + 1, { target: handleFor(rel2.id, held) });

      check('and a slip on a corner of a hand-routed line leaves its corners alone',
        rel2.waypoints.length === 1 && Math.abs(rel2.waypoints[0].x - 300) < 0.01,
        JSON.stringify(rel2.waypoints));
      check('and writes no undo step for that either', state.canUndo() === steps);

      // The same slip on a line that is already hand-routed, where the body drag moves the shape.
      rel2.waypoints = [{ x: 300, y: 40 }];
      state.state.view = { zoom: 2, panX: 0, panY: 0 };
      state.selectOnly('relationships', rel2.id);
      render.render();

      const body = interactions.toScreen(
        geometry.routeRelationship(rel2, 0, 1).label.x,
        geometry.routeRelationship(rel2, 0, 1).label.y);

      pointer('pointerdown', body.x, body.y);
      pointer('pointermove', body.x + 3, body.y + 1);
      pointer('pointerup', body.x + 3, body.y + 1);

      check('and a slip on the line itself moves nothing and writes no undo step either',
        Math.abs(rel2.waypoints[0].x - 300) < 0.01 && state.canUndo() === before,
        JSON.stringify(rel2.waypoints));

      state.state.view = { zoom: 1, panX: 0, panY: 0 };
    }

    // ---- dragging the line itself, on a route that has been shaped by hand
    //
    // Dragging a leg moves that leg alone. Carrying every corner at once would move the middle of the
    // route away from two ends that cannot follow it, and the router would reconnect the two ends
    // differently: one extra leg merging into the leg already there, the other overshooting and
    // coming back as a stub hanging off the line.
    {
      const rel = build('Drag the line');

      // Out of the first card, down, then a long run into the second. Both corners are hand-placed -
      // one was dragged before the line was grabbed.
      const auto = geometry.routeRelationship(rel, 0, 1);
      rel.waypoints = auto.corners.map(corner => ({ x: corner.x, y: corner.y }));
      state.selectOnly('relationships', rel.id);
      render.render();

      const route = geometry.routeRelationship(rel, 0, 1);
      const long = route.points.length - 2;   // the last leg, into the card
      const grab = interactions.toScreen(
        (route.points[long].x + route.points[long + 1].x) / 2, route.points[long].y);

      pointer('pointerdown', grab.x, grab.y);
      pointer('pointermove', grab.x, grab.y + 60);
      pointer('pointerup', grab.x, grab.y + 60);

      const after = geometry.routeRelationship(rel, 0, 1);

      check('dragging a leg of a hand-routed line moves that leg',
        after.points.some(point => Math.abs(point.y - (route.points[long].y + 60)) < 0.01),
        shape(after.points));

      // A point in line with its two neighbours but not between them is a leg that goes out and comes
      // straight back - a stub. There must be none.
      const stubs = after.points.filter((point, at) => {
        if (at === 0 || at === after.points.length - 1) return false;
        const back = after.points[at - 1];
        const on = after.points[at + 1];
        return (Math.abs(back.x - point.x) < 0.01 && Math.abs(point.x - on.x) < 0.01 &&
                (point.y < Math.min(back.y, on.y) - 0.01 || point.y > Math.max(back.y, on.y) + 0.01)) ||
               (Math.abs(back.y - point.y) < 0.01 && Math.abs(point.y - on.y) < 0.01 &&
                (point.x < Math.min(back.x, on.x) - 0.01 || point.x > Math.max(back.x, on.x) + 0.01));
      });

      check('and leaves no leg hanging off the route and coming back on itself',
        stubs.length === 0, shape(after.points) + ' | ' + JSON.stringify(stubs));
      check('both ends are still on their own columns',
        after.start.y === route.start.y && after.end.y === route.end.y);
      check('and every leg is still horizontal or vertical',
        diagonals(after.points).length === 0, shape(after.points));

      // The leg it was grabbed by ends on a card, so there is nothing there to stretch: the route is
      // broken just clear of the card and the new corner carries that end.
      check('a leg held at a card gains the break it needs to move',
        after.corners.length > route.corners.length,
        route.corners.length + ' -> ' + after.corners.length);

      // And the break goes where a step belongs - beside the card - not wherever the router would
      // have put a turn if it had been left to work the reconnection out for itself, which is
      // halfway across the diagram.
      const turn = after.points[after.points.length - 2];

      check('and the break is made just clear of the card, not halfway across the diagram',
        Math.abs(turn.y - after.end.y) < 0.01 && Math.abs(turn.x - after.end.x) <= 24,
        'break at ' + turn.x + ',' + turn.y + ', card at ' + after.end.x + ',' + after.end.y);

      // The same at the other end: the first leg out of the card has nothing behind it to stretch
      // either.
      const other = build('Drag the first leg');
      const plain = geometry.routeRelationship(other, 0, 1);
      other.waypoints = plain.corners.map(corner => ({ x: corner.x, y: corner.y }));
      state.selectOnly('relationships', other.id);
      render.render();

      const head = geometry.routeRelationship(other, 0, 1);
      const first = interactions.toScreen(
        (head.points[0].x + head.points[1].x) / 2, head.points[0].y);

      pointer('pointerdown', first.x, first.y);
      pointer('pointermove', first.x, first.y - 70);
      pointer('pointerup', first.x, first.y - 70);

      const lifted = geometry.routeRelationship(other, 0, 1);
      const away = lifted.points[1];

      check('a first leg out of a card is broken beside that card too',
        Math.abs(away.y - lifted.start.y) < 0.01 && Math.abs(away.x - lifted.start.x) <= 24,
        'break at ' + away.x + ',' + away.y + ', card at ' + lifted.start.x + ',' + lifted.start.y +
        ' ' + shape(lifted.points));
      check('and the leg really did move to where the pointer left it',
        lifted.points.some(point => Math.abs(point.y - (head.points[0].y - 70)) <= 2.01),
        shape(lifted.points));
      check('and that route has no stub on it either',
        diagonals(lifted.points).length === 0, shape(lifted.points));

      // The two offsets move the middle of an automatic shape, and there is no automatic shape left
      // to move the middle of. Writing one as well would move the route twice.
      check('and writes neither offset',
        !rel.routeOffset && !rel.routeOffsetCross,
        rel.routeOffset + ' / ' + rel.routeOffsetCross);

      state.undo();
      check('and undo puts the line back',
        geometry.routeRelationship(state.relationshipById('r-handle'), 0, 1).corners.length ===
          route.corners.length);

      // A leg with a corner at each end has legs either side to stretch, so it moves with no break
      // at all.
      const inner = build('Inner leg', { routeOffset: 30, routeOffsetCross: 90 });
      const stepped = geometry.routeRelationship(inner, 0, 1);
      inner.waypoints = stepped.corners.map(corner => ({ x: corner.x, y: corner.y }));
      state.selectOnly('relationships', inner.id);
      render.render();

      const middle = Math.floor(stepped.points.length / 2) - 1;
      const held = interactions.toScreen(
        (stepped.points[middle].x + stepped.points[middle + 1].x) / 2,
        (stepped.points[middle].y + stepped.points[middle + 1].y) / 2);

      pointer('pointerdown', held.x, held.y);
      pointer('pointermove', held.x + 40, held.y + 40);
      pointer('pointerup', held.x + 40, held.y + 40);

      const settled = geometry.routeRelationship(inner, 0, 1);

      check('a leg with a corner at each end moves without adding one',
        settled.corners.length === stepped.corners.length,
        stepped.corners.length + ' -> ' + settled.corners.length);
      check('and every leg of it is still horizontal or vertical',
        diagonals(settled.points).length === 0, shape(settled.points));

      const hanging = settled.points.filter((point, at) => {
        if (at === 0 || at === settled.points.length - 1) return false;
        const back = settled.points[at - 1];
        const on = settled.points[at + 1];
        return (Math.abs(back.x - point.x) < 0.01 && Math.abs(point.x - on.x) < 0.01 &&
                (point.y < Math.min(back.y, on.y) - 0.01 || point.y > Math.max(back.y, on.y) + 0.01)) ||
               (Math.abs(back.y - point.y) < 0.01 && Math.abs(point.y - on.y) < 0.01 &&
                (point.x < Math.min(back.x, on.x) - 0.01 || point.x > Math.max(back.x, on.x) + 0.01));
      });

      check('and nothing hangs off it and comes back on itself',
        hanging.length === 0, shape(settled.points) + ' | ' + JSON.stringify(hanging));
    }

    // ---- a gesture that never finishes
    {
      const rel = build('Abandoned');
      rel.waypoints = [{ x: 260, y: 40 }, { x: 260, y: 300 }];
      render.render();

      const grabCorner = () => {
        state.selectOnly('relationships', rel.id);
        render.render();

        const route = geometry.routeRelationship(rel, 0, 1);
        const index = route.corners.findIndex(corner => corner.carryX);
        return {
          at: interactions.toScreen(route.corners[index].x, route.corners[index].y),
          handle: handleFor(rel.id, index)
        };
      };

      let grab = grabCorner();
      pointer('pointerdown', grab.at.x, grab.at.y, { target: grab.handle });
      pointer('pointermove', grab.at.x + 80, grab.at.y, { target: grab.handle });
      pointer('pointercancel', grab.at.x + 80, grab.at.y, { target: grab.handle });

      check('a cancelled pointer puts the corner back rather than committing it',
        Math.abs(rel.waypoints[0].x - 260) < 0.01, JSON.stringify(rel.waypoints));

      grab = grabCorner();
      pointer('pointerdown', grab.at.x, grab.at.y, { target: grab.handle });
      pointer('pointermove', grab.at.x + 80, grab.at.y, { target: grab.handle });
      window.dispatchEvent({
        type: 'keydown', key: 'Escape', ctrlKey: false, metaKey: false, shiftKey: false,
        target: { tagName: 'DIV' }, preventDefault() {}, stopPropagation() {}
      });

      check('Escape mid-drag puts the corner back',
        Math.abs(rel.waypoints[0].x - 260) < 0.01, JSON.stringify(rel.waypoints));

      pointer('pointerup', grab.at.x + 80, grab.at.y, { target: grab.handle });
      check('and the release after it commits nothing',
        Math.abs(rel.waypoints[0].x - 260) < 0.01, JSON.stringify(rel.waypoints));

      // A second button going down on top of a drag in flight. Everything below overwrites the drag
      // state, so the abandon at the top of onPointerDown must put the corner back, or it stays where
      // it was dragged to with no undo entry and the diagram not marked unsaved.
      grab = grabCorner();
      pointer('pointerdown', grab.at.x, grab.at.y, { target: grab.handle });
      pointer('pointermove', grab.at.x + 80, grab.at.y, { target: grab.handle });
      pointer('pointerdown', grab.at.x + 80, grab.at.y, { button: 2 });
      pointer('pointerup', grab.at.x + 80, grab.at.y, { button: 2 });

      check('a second button pressed mid-drag puts the corner back too',
        Math.abs(rel.waypoints[0].x - 260) < 0.01, JSON.stringify(rel.waypoints));
    }

    // ---- nothing here reaches an export
    {
      const rel = build('Export');
      rel.waypoints = [{ x: 260, y: 40 }];
      state.selectOnly('relationships', rel.id);
      render.render();

      check('the handles are on screen', serialiseLayer('layer-overlay').includes('data-corner'));
      check('and not inside the connector\'s own group, under the cards',
        !serialiseLayer('layer-links').includes('data-corner'));

      const svgOut = render.buildExportSvg();
      check('the export carries no corner handle', !svgOut.includes('data-corner'), svgOut.slice(0, 200));
      check('nor the tooltip that describes the gesture',
        !svgOut.includes('Drag to move') && !svgOut.includes('Drag left and right'));
      check('and the hand-routed line itself is still drawn',
        svgOut.includes('260') || svgOut.includes('path'));

      // Source checks, on purpose. The handles are drawn in the overlay layer, which the export never
      // touches at all, so neither rule below can be reached by any document. They are there for the
      // next hit target added without remembering that.
      const renderSource = (await import('node:fs')).readFileSync(
        '../../src/Oliver4.DataModelDesigner/Web/js/render.js', 'utf8');

      check('and the export pass names the handle among the attributes it strips',
        /removeAttribute\('data-corner'\)/.test(renderSource));
      check('and among the tooltips it takes off a control',
        /hasAttribute\('data-row-grip'\) \|\| node\.hasAttribute\('data-corner'\)/.test(renderSource));
    }

    // ---- a route shaped by hand does not survive the cards being rearranged
    {
      const rel = build('Rearranged');
      rel.waypoints = [{ x: 300, y: 40 }];
      rel.routeOffset = 20;

      layout.applyLayout('Grid');

      check('an auto-layout puts every connector back on its automatic route',
        !(rel.waypoints || []).length && !rel.routeOffset && !rel.routeOffsetCross,
        JSON.stringify(rel.waypoints) + ' ' + rel.routeOffset);

      // Manual is "never move anything", so it must not take the routing either.
      rel.waypoints = [{ x: 300, y: 40 }];
      layout.applyLayout('Manual');

      check('and Manual, which moves nothing, takes nothing',
        (rel.waypoints || []).length === 1);
    }

    // ---- nor the two ends changing places
    {
      const rel = build('Swapped');
      rel.waypoints = [{ x: 300, y: 40 }];

      const wasFrom = rel.fromTableId;
      rel.fromTableId = rel.toTableId;
      rel.toTableId = wasFrom;
      state.clearManualRoute(rel);

      check('a connector re-pointed at different cards goes back to its automatic route',
        !(rel.waypoints || []).length);

      const inspectorSource = (await import('node:fs')).readFileSync(
        '../../src/Oliver4.DataModelDesigner/Web/js/inspector.js', 'utf8');
      const proposedSource = (await import('node:fs')).readFileSync(
        '../../src/Oliver4.DataModelDesigner/Web/js/proposed.js', 'utf8');

      check('and the inspector\'s two end pickers do it',
        (inspectorSource.match(/clearManualRoute\(relationship\)/g) || []).length === 2);
      check('and so do both proposed-relationship editors, but only when the ends change',
        (proposedSource.match(/if \(repointed\) clearManualRoute\(/g) || []).length === 2);
    }

    // ---- the export dialog says which formats redraw the lines
    {
      const rel = build('Export warning');
      rel.waypoints = [{ x: 300, y: 40 }];

      const { collectWarnings } = await import(js + 'exporter.js');
      const says = format => collectWarnings(format).some(line => /hand-routed/.test(line));

      check('draw.io warns that it redraws a hand-routed connector', says('DrawIo'),
        JSON.stringify(collectWarnings('DrawIo')));
      check('and Visio does', says('Visio'));
      check('and Mermaid does', says('Mermaid'));
      check('and the picture formats, which honour it, do not',
        !says('Png') && !says('Svg'));

      state.clearManualRoute(rel);
      check('and a diagram with no hand routing is told nothing about it', !says('DrawIo'));

      // A connector taken off the canvas is not in the picture, so it is not in the count either.
      rel.waypoints = [{ x: 300, y: 40 }];
      rel.hidden = true;
      check('nor is a hidden connector counted', !says('DrawIo'));
      rel.hidden = false;
    }

    // ---- a step clear of a card lands outside it, not in the card opposite
    {
      const doc = fresh('Nearly touching');

      const left = card('n-left', 'account', 'Account');
      const right = card('n-right', 'contact', 'Contact', [
        column('n-rightfk', 'parentcustomerid', 'Customer', { isLookup: true, targets: ['account'] })
      ]);
      doc.tables.push(left, right);
      doc.settings.fieldDetail = 'RelationshipFields';

      const rel = link('r-tight', left.id, right.id,
        { referencedAttribute: 'accountid', referencingAttribute: 'parentcustomerid' });
      doc.relationships.push(rel);
      geometry.invalidateSizes();

      // Two cards with less than the usual step between them, which is where an eighteen-unit step
      // clear of one card lands inside the other and the connector is drawn across a table.
      const width = geometry.tableRect(left).width;
      left.x = 0; left.y = 0;
      right.x = width + 14; right.y = 10;
      geometry.invalidateSizes();

      const auto = geometry.routeRelationship(rel, 0, 1);
      const cards = [geometry.tableRect(left), geometry.tableRect(right)];

      const crossesACard = points => geometry.segmentsOf(points).some(seg => cards.some(rect =>
        Math.min(seg.a.x, seg.b.x) < rect.x + rect.width - 0.01 &&
        Math.max(seg.a.x, seg.b.x) > rect.x + 0.01 &&
        Math.min(seg.a.y, seg.b.y) < rect.y + rect.height - 0.01 &&
        Math.max(seg.a.y, seg.b.y) > rect.y + 0.01));

      rel.waypoints = [{ x: auto.start.x, y: auto.start.y - 100 }];
      check('a corner on the start anchor\'s line does not step into the card opposite',
        !crossesACard(geometry.routeRelationship(rel, 0, 1).points),
        shape(geometry.routeRelationship(rel, 0, 1).points));

      rel.waypoints = [{ x: auto.end.x, y: auto.end.y - 160 }];
      check('nor does one on the end anchor\'s line',
        !crossesACard(geometry.routeRelationship(rel, 0, 1).points),
        shape(geometry.routeRelationship(rel, 0, 1).points));

      rel.waypoints = [];
    }

    // ---- a guard no document reaches
    {
      const source = (await import('node:fs')).readFileSync(
        '../../src/Oliver4.DataModelDesigner/Web/js/geometry.js', 'utf8');

      // A source check on purpose. Taking a point out of the middle of a route can leave its two
      // neighbours on top of each other, but it needs a pair of exact coincidences that no drag
      // produces. It is there for the next shape added to the router.
      check('tidy de-duplicates again after taking a point out of the middle',
        /kept = dedupe\(kept\);/.test(source));
    }

    uiModule.closeModal();
    state.clearSelection();
    state.state.view = { zoom: 1, panX: 0, panY: 0 };
  }
}

console.log('\nInterop with the C# document');
const fs = await import('node:fs');
if (fs.existsSync('./interop-document.json')) {
  const hostDoc = JSON.parse(fs.readFileSync('./interop-document.json', 'utf8'));
  state.setDocument(hostDoc, null);
  geometry.invalidateSizes();

  check('host document loads', state.state.doc.tables.length === 7, String(state.state.doc.tables.length));
  check('table positions came through',
    state.state.doc.tables.every(t => Number.isFinite(t.x) && Number.isFinite(t.y)));
  check('status enums came through as strings',
    state.state.doc.tables.some(t => t.status === 'Proposed') &&
    state.state.doc.tables.some(t => t.status === 'Deprecated') &&
    state.state.doc.tables.some(t => t.status === 'External'));
  check('field detail setting came through',
    ['TablesOnly', 'RelationshipFields', 'AllFields'].includes(state.state.doc.settings.fieldDetail),
    state.state.doc.settings.fieldDetail);
  check('cascade came through',
    state.state.doc.relationships.some(r => r.cascade && r.cascade.delete === 'RemoveLink'));
  check('excluded relationship came through',
    state.state.doc.relationships.some(r => r.included === false));
  check('lookup columns came through',
    state.state.doc.tables.some(t => (t.columns || []).some(c => c.isLookup)));
  check('annotations came through', state.state.doc.annotations.length === 3,
    String(state.state.doc.annotations.length));

  // The three kinds are the one place the two runtimes could quietly disagree: the host writes
  // "kind" as a string and the canvas branches on it, so a rename on either side would show up as
  // arrows drawn as empty notes rather than as an error.
  check('the host\'s sticky note is a sticky note here',
    state.state.doc.annotations.some(a => state.annotationKind(a) === 'note'));
  check('the host\'s text box is a text box here',
    state.state.doc.annotations.some(a => state.annotationKind(a) === 'text'));
  check('the host\'s arrow is an arrow here, with its vector intact',
    state.state.doc.annotations.some(a =>
      state.annotationKind(a) === 'arrow' && a.dx === -120 && a.dy === -80));
  check('a relationship-owned lookup column came through',
    state.state.doc.tables.some(t => (t.columns || []).some(c => c.fromRelationshipId)));

  // The host writes the file, so a corner the canvas placed only survives if it is on the host
  // model too - and it only draws where the user put it if the two agree on the order.
  {
    const routed = state.state.doc.relationships.find(r => (r.waypoints || []).length);

    check('the host\'s hand-placed connector corners came through, in order',
      !!routed && routed.waypoints.length === 2 &&
      Math.abs(routed.waypoints[0].x - 220.5) < 0.001 &&
      Math.abs(routed.waypoints[1].y - 260.25) < 0.001,
      JSON.stringify(routed && routed.waypoints));

    if (routed) {
      const route = geometry.routeRelationship(routed, 0, 1);
      check('and the canvas routes through them rather than ignoring them',
        !!route && route.manual === true &&
        route.corners.filter(corner => corner.waypointIndex !== null).length === 2);
    }
  }

  render.render();
  const hostSvg = render.buildExportSvg();
  check('host document renders to SVG', hostSvg.length > 1000 && balanced(hostSvg));
  check('host document renders its proposed table', hostSvg.includes('Customer Segment'));
  check('host document renders its deprecated table', hostSvg.includes('DEPRECATED'));
  check('host document renders its external table', hostSvg.includes('EXTERNAL'));
} else {
  console.log('  skip interop check - run the C# verification first');
}

console.log('\n' + (failures === 0 ? 'ALL CANVAS CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
