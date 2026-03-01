// Variable Updater — generic Figma plugin
// Accepts a JSON file via UI and applies overrides to Local Variables

figma.showUI(__html__, { width: 440, height: 560, themeColors: true });

function hexToRGBA(hex) {
  hex = hex.replace('#', '');
  var r, g, b, a = 1;
  if (hex.length === 8) {
    r = parseInt(hex.slice(0, 2), 16) / 255;
    g = parseInt(hex.slice(2, 4), 16) / 255;
    b = parseInt(hex.slice(4, 6), 16) / 255;
    a = parseInt(hex.slice(6, 8), 16) / 255;
  } else {
    r = parseInt(hex.slice(0, 2), 16) / 255;
    g = parseInt(hex.slice(2, 4), 16) / 255;
    b = parseInt(hex.slice(4, 6), 16) / 255;
  }
  return { r: r, g: g, b: b, a: a };
}

function sendLog(text, level) {
  figma.ui.postMessage({ type: 'log', text: text, level: level || 'info' });
}

async function loadFontsForOverrides(overrides) {
  // Collect all string values that target font variables
  var fontNames = [];
  for (var i = 0; i < overrides.length; i++) {
    var ov = overrides[i];
    if (typeof ov.value === 'string' && ov.value.charAt(0) !== '#' &&
        ov.variable && ov.variable.toLowerCase().indexOf('font') !== -1) {
      fontNames.push(ov.value);
    }
  }

  // Load all needed font styles
  var styles = ['Regular', 'Medium', 'SemiBold', 'Bold', 'Light', 'ExtraLight', 'Thin', 'ExtraBold', 'Black'];
  for (var i = 0; i < fontNames.length; i++) {
    for (var j = 0; j < styles.length; j++) {
      try {
        await figma.loadFontAsync({ family: fontNames[i], style: styles[j] });
      } catch (e) {
        // style not available, skip
      }
    }
  }
}

async function applyOverrides(overrides, dryRun) {
  sendLog('Variable Updater starting...');
  sendLog(overrides.length + ' overrides to apply');
  if (dryRun) sendLog('DRY RUN — no changes will be made', 'info');

  // Load fonts first
  sendLog('Loading fonts...');
  await loadFontsForOverrides(overrides);
  sendLog('Fonts loaded');

  var allVars = await figma.variables.getLocalVariablesAsync();
  var allCollections = await figma.variables.getLocalVariableCollectionsAsync();

  sendLog('Found ' + allCollections.length + ' collections, ' + allVars.length + ' variables');

  var collectionMap = new Map();
  var varsByCollection = new Map();

  for (var i = 0; i < allCollections.length; i++) {
    var col = allCollections[i];
    var modeMap = new Map();
    for (var j = 0; j < col.modes.length; j++) {
      modeMap.set(col.modes[j].name, col.modes[j].modeId);
    }
    collectionMap.set(col.name, { collection: col, modeMap: modeMap });
    varsByCollection.set(col.id, new Map());
    sendLog('  Collection: "' + col.name + '" → modes: [' + Array.from(modeMap.keys()).join(', ') + ']');
  }

  for (var i = 0; i < allVars.length; i++) {
    var v = allVars[i];
    var colVars = varsByCollection.get(v.variableCollectionId);
    if (colVars) colVars.set(v.name, v);
  }

  sendLog('');
  sendLog('--- Applying overrides ---');

  var applied = 0;
  var skipped = 0;
  var errors = [];

  for (var i = 0; i < overrides.length; i++) {
    var ov = overrides[i];
    var foundEntry = undefined;
    var foundColName = '';

    collectionMap.forEach(function(entry, name) {
      if (!foundEntry && name.indexOf(ov.collection) !== -1) {
        foundEntry = entry;
        foundColName = name;
      }
    });

    if (!foundEntry) {
      var msg = 'Collection "' + ov.collection + '" not found for ' + ov.variable;
      errors.push(msg);
      sendLog('  SKIP: ' + msg, 'err');
      skipped++;
      continue;
    }

    var colVars = varsByCollection.get(foundEntry.collection.id);
    var targetVar = colVars ? colVars.get(ov.variable) : undefined;

    if (!targetVar) {
      var msg = 'Variable "' + ov.variable + '" not found in "' + foundColName + '"';
      errors.push(msg);
      sendLog('  SKIP: ' + msg, 'err');
      skipped++;
      continue;
    }

    var modeId;
    if (ov.mode) {
      modeId = foundEntry.modeMap.get(ov.mode);
      if (!modeId) {
        var msg = 'Mode "' + ov.mode + '" not found in "' + foundColName + '"';
        errors.push(msg);
        sendLog('  SKIP: ' + msg, 'err');
        skipped++;
        continue;
      }
    } else {
      modeId = foundEntry.collection.modes[0].modeId;
    }

    if (dryRun) {
      applied++;
      sendLog('  DRY: ' + ov.variable + (ov.mode ? ' [' + ov.mode + ']' : '') + ' → ' + ov.value, 'ok');
      continue;
    }

    try {
      if (typeof ov.value === 'number') {
        targetVar.setValueForMode(modeId, ov.value);
      } else if (typeof ov.value === 'string' && ov.value.charAt(0) === '#') {
        targetVar.setValueForMode(modeId, hexToRGBA(ov.value));
      } else {
        targetVar.setValueForMode(modeId, ov.value);
      }
      applied++;
      sendLog('  OK: ' + ov.variable + (ov.mode ? ' [' + ov.mode + ']' : '') + ' = ' + ov.value, 'ok');
    } catch (e) {
      var msg = 'Set failed: ' + ov.variable + ' — ' + (e.message || e);
      errors.push(msg);
      sendLog('  ERR: ' + msg, 'err');
      skipped++;
    }
  }

  var summaryText = (dryRun ? '[DRY RUN] ' : '') +
    'Applied: ' + applied + '/' + overrides.length +
    (skipped > 0 ? ' | Skipped: ' + skipped : '');

  sendLog('');
  sendLog('══════════════════════════════════════════');

  figma.ui.postMessage({ type: 'done', summary: summaryText });
}

figma.ui.onmessage = function(msg) {
  if (msg.type === 'apply-overrides') {
    applyOverrides(msg.overrides, msg.dryRun);
  }
};
