// Design System Auditor — Figma plugin
// Generic, config-driven theme auditor with auto-fix capability.
// Drop a JSON config to define which colors/fonts to flag, and
// optionally map them to replacement variables or font families.

figma.showUI(__html__, { width: 520, height: 700, themeColors: true });

// ──────────────────────────────────────────────
// State
// ──────────────────────────────────────────────
var config = null;           // user-supplied config JSON
var lastAuditResult = null;  // saved for fix-all

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────
function rgbaToHex(c) {
  var r = Math.round(c.r * 255);
  var g = Math.round(c.g * 255);
  var b = Math.round(c.b * 255);
  var hex = '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  if (c.a !== undefined && c.a < 1) {
    hex += Math.round(c.a * 255).toString(16).padStart(2, '0');
  }
  return hex.toLowerCase();
}

function sendLog(text, level) {
  figma.ui.postMessage({ type: 'log', text: text, level: level || 'info' });
}

function sendProgress(current, total) {
  figma.ui.postMessage({ type: 'progress', current: current, total: total });
}

function getPageName(node) {
  var current = node;
  while (current.parent && current.parent.type !== 'DOCUMENT') {
    current = current.parent;
  }
  return current.name || '(unknown)';
}

function collectNodes(node, list) {
  list.push(node);
  if ('children' in node) {
    for (var i = 0; i < node.children.length; i++) {
      collectNodes(node.children[i], list);
    }
  }
}

function hexToRgb01(hex) {
  hex = hex.replace('#', '');
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
  };
}

// ──────────────────────────────────────────────
// Build runtime detection maps from config
// ──────────────────────────────────────────────
function buildDetectionMaps() {
  var detectColors = {};
  var detectShadowBases = {};
  var allowedFonts = [];

  if (config && config.detect) {
    if (config.detect.colors) {
      Object.keys(config.detect.colors).forEach(function(hex) {
        detectColors[hex.toLowerCase()] = config.detect.colors[hex];
      });
    }
    if (config.detect.shadowBases) {
      Object.keys(config.detect.shadowBases).forEach(function(hex) {
        detectShadowBases[hex.toLowerCase()] = config.detect.shadowBases[hex];
        // Shadow bases are also flagged as old colors
        detectColors[hex.toLowerCase()] = config.detect.shadowBases[hex];
      });
    }
    if (config.detect.fonts && Array.isArray(config.detect.fonts)) {
      allowedFonts = config.detect.fonts;
    }
  }

  return {
    detectColors: detectColors,
    detectShadowBases: detectShadowBases,
    allowedFonts: allowedFonts,
  };
}

// ──────────────────────────────────────────────
// Main Audit
// ──────────────────────────────────────────────
async function runAudit() {
  var maps = buildDetectionMaps();
  var hasColorDetection = Object.keys(maps.detectColors).length > 0;
  var hasFontDetection = maps.allowedFonts.length > 0;
  var hasShadowDetection = Object.keys(maps.detectShadowBases).length > 0;

  sendLog('Theme Audit starting...');
  if (config && config.name) sendLog('Config: ' + config.name);
  sendLog('Scanning all pages and nodes...\n');

  if (!hasColorDetection && !hasFontDetection) {
    sendLog('No detection rules loaded — reporting variable binding stats only.', 'info');
  }

  var issues = {
    hardcodedOldColors: [],
    fontMismatches: [],
    unboundFills: 0,
    unboundStrokes: 0,
    totalNodes: 0,
    totalTextNodes: 0,
    totalWithFills: 0,
    totalWithStrokes: 0,
    variableBoundFills: 0,
    variableBoundStrokes: 0,
  };

  var pages = figma.root.children;
  var allNodes = [];
  for (var p = 0; p < pages.length; p++) {
    collectNodes(pages[p], allNodes);
  }
  issues.totalNodes = allNodes.length;
  sendLog('Found ' + allNodes.length + ' nodes across ' + pages.length + ' pages');

  var batchSize = 500;

  for (var i = 0; i < allNodes.length; i++) {
    var node = allNodes[i];

    // --- Fills ---
    if ('fills' in node && Array.isArray(node.fills)) {
      for (var f = 0; f < node.fills.length; f++) {
        var fill = node.fills[f];
        if (fill.type === 'SOLID' && fill.visible !== false) {
          issues.totalWithFills++;
          var hex = rgbaToHex(fill.color).slice(0, 7);
          var isBound = false;
          try {
            var fb = node.boundVariables && node.boundVariables.fills;
            if (fb && fb[f]) isBound = true;
          } catch (e) {}

          if (isBound) {
            issues.variableBoundFills++;
          } else {
            issues.unboundFills++;
            if (hasColorDetection && maps.detectColors[hex]) {
              issues.hardcodedOldColors.push({
                nodeId: node.id, nodeName: node.name, page: getPageName(node),
                property: 'fill', paintIndex: f, hex: hex,
                oldName: maps.detectColors[hex],
              });
            }
          }
        }
      }
    }

    // --- Strokes ---
    if ('strokes' in node && Array.isArray(node.strokes)) {
      for (var s = 0; s < node.strokes.length; s++) {
        var stroke = node.strokes[s];
        if (stroke.type === 'SOLID' && stroke.visible !== false) {
          issues.totalWithStrokes++;
          var sHex = rgbaToHex(stroke.color).slice(0, 7);
          var sIsBound = false;
          try {
            var sb = node.boundVariables && node.boundVariables.strokes;
            if (sb && sb[s]) sIsBound = true;
          } catch (e) {}

          if (sIsBound) {
            issues.variableBoundStrokes++;
          } else {
            issues.unboundStrokes++;
            if (hasColorDetection && maps.detectColors[sHex]) {
              issues.hardcodedOldColors.push({
                nodeId: node.id, nodeName: node.name, page: getPageName(node),
                property: 'stroke', paintIndex: s, hex: sHex,
                oldName: maps.detectColors[sHex],
              });
            }
          }
        }
      }
    }

    // --- Text fonts ---
    if (node.type === 'TEXT') {
      issues.totalTextNodes++;
      if (hasFontDetection) {
        try {
          var fontName = node.fontName;
          if (fontName && fontName !== figma.mixed) {
            if (maps.allowedFonts.indexOf(fontName.family) === -1) {
              issues.fontMismatches.push({
                nodeId: node.id, nodeName: node.name, page: getPageName(node),
                font: fontName.family, style: fontName.style,
                expected: maps.allowedFonts.join(', '),
              });
            }
          }
        } catch (e) { /* mixed fonts — skip */ }
      }
    }

    if ((i + 1) % batchSize === 0) {
      sendProgress(i + 1, allNodes.length);
      await new Promise(function(r) { setTimeout(r, 0); });
    }
  }

  // --- Local styles ---
  sendLog('\n--- Checking Local Styles ---');
  var localPaintStyles = await figma.getLocalPaintStylesAsync();
  var localTextStyles = await figma.getLocalTextStylesAsync();
  var localEffectStyles = await figma.getLocalEffectStylesAsync();

  var styleIssues = { paint: [], text: [], effect: [] };

  if (hasColorDetection) {
    for (var ps = 0; ps < localPaintStyles.length; ps++) {
      var pStyle = localPaintStyles[ps];
      for (var sp = 0; sp < pStyle.paints.length; sp++) {
        var paint = pStyle.paints[sp];
        if (paint.type === 'SOLID') {
          var pHex = rgbaToHex(paint.color).slice(0, 7);
          if (maps.detectColors[pHex]) {
            styleIssues.paint.push({
              styleId: pStyle.id, styleName: pStyle.name,
              paintIndex: sp, hex: pHex, oldName: maps.detectColors[pHex],
            });
          }
        }
      }
    }
  }

  if (hasFontDetection) {
    for (var ts = 0; ts < localTextStyles.length; ts++) {
      var tStyle = localTextStyles[ts];
      try {
        if (tStyle.fontName && tStyle.fontName.family &&
            maps.allowedFonts.indexOf(tStyle.fontName.family) === -1) {
          styleIssues.text.push({
            styleId: tStyle.id, styleName: tStyle.name,
            font: tStyle.fontName.family, style: tStyle.fontName.style,
          });
        }
      } catch (e) {}
    }
  }

  if (hasShadowDetection) {
    for (var es = 0; es < localEffectStyles.length; es++) {
      var eStyle = localEffectStyles[es];
      for (var ef = 0; ef < eStyle.effects.length; ef++) {
        var eff = eStyle.effects[ef];
        if (eff.type === 'DROP_SHADOW' || eff.type === 'INNER_SHADOW') {
          var eHex = rgbaToHex(eff.color).slice(0, 7);
          if (maps.detectShadowBases[eHex]) {
            styleIssues.effect.push({
              styleId: eStyle.id, styleName: eStyle.name,
              effectIndex: ef, hex: eHex, oldName: maps.detectShadowBases[eHex],
            });
          }
        }
      }
    }
  }

  // ── Report ──
  sendLog('\n══════════════════════════════════════════');
  sendLog('AUDIT REPORT', 'summary');
  sendLog('══════════════════════════════════════════\n');

  sendLog('Nodes scanned: ' + issues.totalNodes);
  sendLog('Text nodes: ' + issues.totalTextNodes);
  sendLog('');

  var fillPct = issues.totalWithFills > 0
    ? Math.round(issues.variableBoundFills / issues.totalWithFills * 100) : 100;
  var strokePct = issues.totalWithStrokes > 0
    ? Math.round(issues.variableBoundStrokes / issues.totalWithStrokes * 100) : 100;

  sendLog('VARIABLE BINDING COVERAGE:', 'summary');
  sendLog('  Fills:   ' + issues.variableBoundFills + '/' + issues.totalWithFills + ' (' + fillPct + '%)', fillPct === 100 ? 'ok' : 'info');
  sendLog('  Strokes: ' + issues.variableBoundStrokes + '/' + issues.totalWithStrokes + ' (' + strokePct + '%)', strokePct === 100 ? 'ok' : 'info');
  sendLog('');

  if (hasColorDetection) {
    if (issues.hardcodedOldColors.length === 0) {
      sendLog('FLAGGED COLORS: None found ✓', 'ok');
    } else {
      sendLog('FLAGGED COLORS: ' + issues.hardcodedOldColors.length + ' found!', 'err');
      var byColor = {};
      issues.hardcodedOldColors.forEach(function(item) {
        var key = item.hex + ' (' + item.oldName + ')';
        if (!byColor[key]) byColor[key] = [];
        byColor[key].push(item);
      });
      Object.keys(byColor).forEach(function(key) {
        var items = byColor[key];
        sendLog('  ' + key + ': ' + items.length + ' instances', 'err');
        items.slice(0, 3).forEach(function(item) {
          sendLog('    → ' + item.page + ' / ' + item.nodeName + ' (' + item.property + ')', 'err');
        });
        if (items.length > 3) sendLog('    ... and ' + (items.length - 3) + ' more', 'err');
      });
    }
    sendLog('');
  }

  if (hasFontDetection) {
    if (issues.fontMismatches.length === 0) {
      sendLog('FONT CHECK: All text OK ✓', 'ok');
    } else {
      sendLog('FONT MISMATCHES: ' + issues.fontMismatches.length + ' text nodes', 'err');
      var byFont = {};
      issues.fontMismatches.forEach(function(item) {
        if (!byFont[item.font]) byFont[item.font] = [];
        byFont[item.font].push(item);
      });
      Object.keys(byFont).forEach(function(font) {
        var items = byFont[font];
        sendLog('  "' + font + '": ' + items.length + ' nodes', 'err');
        items.slice(0, 3).forEach(function(item) {
          sendLog('    → ' + item.page + ' / ' + item.nodeName, 'err');
        });
        if (items.length > 3) sendLog('    ... and ' + (items.length - 3) + ' more', 'err');
      });
    }
    sendLog('');
  }

  sendLog('LOCAL STYLES:', 'summary');
  sendLog('  Paint styles: ' + localPaintStyles.length +
    (styleIssues.paint.length > 0 ? ' (' + styleIssues.paint.length + ' flagged)' : ' ✓'));
  styleIssues.paint.forEach(function(item) {
    sendLog('    ✗ ' + item.styleName + ' → ' + item.hex + ' (' + item.oldName + ')', 'err');
  });
  sendLog('  Text styles: ' + localTextStyles.length +
    (styleIssues.text.length > 0 ? ' (' + styleIssues.text.length + ' flagged)' : ' ✓'));
  styleIssues.text.forEach(function(item) {
    sendLog('    ✗ ' + item.styleName + ' → ' + item.font + ' ' + item.style, 'err');
  });
  sendLog('  Effect styles: ' + localEffectStyles.length +
    (styleIssues.effect.length > 0 ? ' (' + styleIssues.effect.length + ' flagged)' : ' ✓'));
  styleIssues.effect.forEach(function(item) {
    sendLog('    ✗ ' + item.styleName + ' → ' + item.hex + ' (' + item.oldName + ')', 'err');
  });

  sendLog('\n══════════════════════════════════════════');
  var totalIssues = issues.hardcodedOldColors.length + issues.fontMismatches.length +
    styleIssues.paint.length + styleIssues.text.length + styleIssues.effect.length;

  if (totalIssues === 0) {
    sendLog('PUBLISH READY ✓', 'ok');
  } else {
    sendLog('NOT READY — ' + totalIssues + ' issues to fix', 'err');
  }

  var summaryData = {
    totalNodes: issues.totalNodes,
    oldColorCount: issues.hardcodedOldColors.length,
    fontMismatchCount: issues.fontMismatches.length,
    styleIssues: styleIssues.paint.length + styleIssues.text.length + styleIssues.effect.length,
    publishReady: totalIssues === 0,
    fillCoverage: fillPct,
    strokeCoverage: strokePct,
    hardcodedOldColors: issues.hardcodedOldColors,
    fontMismatches: issues.fontMismatches,
    paintStyleIssues: styleIssues.paint,
    textStyleIssues: styleIssues.text,
    effectStyleIssues: styleIssues.effect,
  };
  lastAuditResult = summaryData;

  var hasFixConfig = config && config.fix && (
    (config.fix.colorToVariable && Object.keys(config.fix.colorToVariable).length > 0) ||
    (config.fix.colorReplace && Object.keys(config.fix.colorReplace).length > 0) ||
    (config.fix.fontReplace && Object.keys(config.fix.fontReplace).length > 0)
  );

  figma.ui.postMessage({
    type: 'audit-done',
    summary: summaryData,
    canFix: hasFixConfig && totalIssues > 0,
  });
}

// ──────────────────────────────────────────────
// Fix All
// ──────────────────────────────────────────────
async function runFix(dryRun) {
  if (!lastAuditResult || !config || !config.fix) {
    sendLog('No audit results or fix config. Run audit first.', 'err');
    return;
  }

  sendLog('\n' + (dryRun ? 'DRY RUN — ' : 'FIX — ') + 'starting...\n');

  var stats = {
    colorFixed: 0, colorFailed: 0, colorSkipped: 0,
    fontFixed: 0, fontFailed: 0, fontSkipped: 0,
    styleFixed: 0, styleFailed: 0,
    effectFixed: 0, effectFailed: 0, effectSkipped: 0,
  };

  // Build color maps
  var colorMap = {};
  if (config.fix.colorToVariable) {
    Object.keys(config.fix.colorToVariable).forEach(function(hex) {
      colorMap[hex.toLowerCase()] = config.fix.colorToVariable[hex];
    });
  }
  var hexReplace = {};
  if (config.fix.colorReplace) {
    Object.keys(config.fix.colorReplace).forEach(function(hex) {
      hexReplace[hex.toLowerCase()] = config.fix.colorReplace[hex].toLowerCase();
    });
  }
  var hasColorFix = Object.keys(colorMap).length > 0 || Object.keys(hexReplace).length > 0;

  // ── Fix hardcoded colors → bind to variables or replace hex ──
  if (hasColorFix) {

    // Load all COLOR variables for lookup
    var allVars = await figma.variables.getLocalVariablesAsync('COLOR');
    sendLog('Loaded ' + allVars.length + ' color variables for lookup');

    function findVariable(targetName) {
      // Exact match first
      for (var i = 0; i < allVars.length; i++) {
        if (allVars[i].name === targetName) return allVars[i];
      }
      // Substring match
      for (var j = 0; j < allVars.length; j++) {
        if (allVars[j].name.indexOf(targetName) !== -1) return allVars[j];
      }
      return null;
    }

    // Fix node fills / strokes
    sendLog('\n--- Fixing node colors (' + lastAuditResult.hardcodedOldColors.length + ') ---');
    for (var ci = 0; ci < lastAuditResult.hardcodedOldColors.length; ci++) {
      var item = lastAuditResult.hardcodedOldColors[ci];

      // Strategy 1: bind to variable
      var targetVarName = colorMap[item.hex];
      var variable = targetVarName ? findVariable(targetVarName) : null;

      if (variable) {
        if (dryRun) {
          sendLog('  WOULD BIND ' + item.nodeName + ' ' + item.property + ' ' + item.hex + ' → ' + variable.name, 'ok');
          stats.colorFixed++;
          continue;
        }
        try {
          var node = await figma.getNodeByIdAsync(item.nodeId);
          if (!node) throw new Error('node not found');
          if (item.property === 'fill') {
            var fills = JSON.parse(JSON.stringify(node.fills));
            fills[item.paintIndex] = figma.variables.setBoundVariableForPaint(
              fills[item.paintIndex], 'color', variable
            );
            node.fills = fills;
          } else {
            var strokes = JSON.parse(JSON.stringify(node.strokes));
            strokes[item.paintIndex] = figma.variables.setBoundVariableForPaint(
              strokes[item.paintIndex], 'color', variable
            );
            node.strokes = strokes;
          }
          sendLog('  BOUND ' + item.nodeName + ' ' + item.property + ' → ' + variable.name, 'ok');
          stats.colorFixed++;
        } catch (e) {
          sendLog('  FAIL ' + item.nodeName + ' — ' + e.message, 'err');
          stats.colorFailed++;
        }
        continue;
      }

      // Strategy 2: direct hex replacement
      var replHex = hexReplace[item.hex];
      if (replHex) {
        if (dryRun) {
          sendLog('  WOULD REPLACE ' + item.nodeName + ' ' + item.property + ' ' + item.hex + ' → ' + replHex, 'ok');
          stats.colorFixed++;
          continue;
        }
        try {
          var rNode = await figma.getNodeByIdAsync(item.nodeId);
          if (!rNode) throw new Error('node not found');
          var newRgb = hexToRgb01(replHex);
          if (item.property === 'fill') {
            var rFills = JSON.parse(JSON.stringify(rNode.fills));
            rFills[item.paintIndex].color = newRgb;
            rNode.fills = rFills;
          } else {
            var rStrokes = JSON.parse(JSON.stringify(rNode.strokes));
            rStrokes[item.paintIndex].color = newRgb;
            rNode.strokes = rStrokes;
          }
          sendLog('  REPLACED ' + item.nodeName + ' ' + item.property + ' → ' + replHex, 'ok');
          stats.colorFixed++;
        } catch (e) {
          sendLog('  FAIL ' + item.nodeName + ' — ' + e.message, 'err');
          stats.colorFailed++;
        }
        continue;
      }

      stats.colorSkipped++;
    }

    // Deduplicate skip messages
    if (stats.colorSkipped > 0) {
      sendLog('  SKIPPED ' + stats.colorSkipped + ' nodes — no mapping', 'info');
    }

    // Fix paint styles
    if (lastAuditResult.paintStyleIssues.length > 0) {
      sendLog('\n--- Fixing paint styles (' + lastAuditResult.paintStyleIssues.length + ') ---');
      for (var pi = 0; pi < lastAuditResult.paintStyleIssues.length; pi++) {
        var pItem = lastAuditResult.paintStyleIssues[pi];

        // Strategy 1: bind to variable
        var pTargetName = colorMap[pItem.hex];
        var pVar = pTargetName ? findVariable(pTargetName) : null;

        if (pVar) {
          if (dryRun) {
            sendLog('  WOULD BIND style ' + pItem.styleName + ' → ' + pVar.name, 'ok');
            stats.styleFixed++; continue;
          }
          try {
            var pStyle = figma.getStyleById(pItem.styleId);
            if (!pStyle) throw new Error('style not found');
            var paints = JSON.parse(JSON.stringify(pStyle.paints));
            paints[pItem.paintIndex] = figma.variables.setBoundVariableForPaint(
              paints[pItem.paintIndex], 'color', pVar
            );
            pStyle.paints = paints;
            sendLog('  BOUND style ' + pItem.styleName + ' → ' + pVar.name, 'ok');
            stats.styleFixed++;
          } catch (e) {
            sendLog('  FAIL style ' + pItem.styleName + ' — ' + e.message, 'err');
            stats.styleFailed++;
          }
          continue;
        }

        // Strategy 2: direct hex replacement
        var pReplHex = hexReplace[pItem.hex];
        if (pReplHex) {
          if (dryRun) {
            sendLog('  WOULD REPLACE style ' + pItem.styleName + ' ' + pItem.hex + ' → ' + pReplHex, 'ok');
            stats.styleFixed++; continue;
          }
          try {
            var pStyle2 = figma.getStyleById(pItem.styleId);
            if (!pStyle2) throw new Error('style not found');
            var paints2 = JSON.parse(JSON.stringify(pStyle2.paints));
            paints2[pItem.paintIndex].color = hexToRgb01(pReplHex);
            pStyle2.paints = paints2;
            sendLog('  REPLACED style ' + pItem.styleName + ' → ' + pReplHex, 'ok');
            stats.styleFixed++;
          } catch (e) {
            sendLog('  FAIL style ' + pItem.styleName + ' — ' + e.message, 'err');
            stats.styleFailed++;
          }
          continue;
        }

        sendLog('  SKIP style ' + pItem.styleName + ' — no mapping for ' + pItem.hex, 'info');
      }
    }

    // Fix effect styles (shadows — can't bind variables, hex replace only)
    if (lastAuditResult.effectStyleIssues && lastAuditResult.effectStyleIssues.length > 0) {
      sendLog('\n--- Fixing effect styles (' + lastAuditResult.effectStyleIssues.length + ') ---');
      for (var ei = 0; ei < lastAuditResult.effectStyleIssues.length; ei++) {
        var eItem = lastAuditResult.effectStyleIssues[ei];
        var eReplHex = hexReplace[eItem.hex];
        if (!eReplHex) {
          sendLog('  SKIP effect ' + eItem.styleName + ' — no colorReplace for ' + eItem.hex, 'info');
          stats.effectSkipped++;
          continue;
        }

        if (dryRun) {
          sendLog('  WOULD REPLACE effect ' + eItem.styleName + ' shadow base ' + eItem.hex + ' → ' + eReplHex, 'ok');
          stats.effectFixed++;
          continue;
        }

        try {
          var eStyle = figma.getStyleById(eItem.styleId);
          if (!eStyle) throw new Error('style not found');
          var effects = JSON.parse(JSON.stringify(eStyle.effects));
          var eff = effects[eItem.effectIndex];
          var newRgb = hexToRgb01(eReplHex);
          // Preserve original alpha
          eff.color = { r: newRgb.r, g: newRgb.g, b: newRgb.b, a: eff.color.a };
          eStyle.effects = effects;
          sendLog('  REPLACED effect ' + eItem.styleName + ' → base ' + eReplHex + ' (alpha preserved)', 'ok');
          stats.effectFixed++;
        } catch (e) {
          sendLog('  FAIL effect ' + eItem.styleName + ' — ' + e.message, 'err');
          stats.effectFailed++;
        }
      }
    }
  }

  // ── Fix font mismatches ──
  if (config.fix.fontReplace && Object.keys(config.fix.fontReplace).length > 0) {
    var fontMap = {};
    Object.keys(config.fix.fontReplace).forEach(function(k) {
      fontMap[k.toLowerCase()] = config.fix.fontReplace[k];
    });
    var fallbackFont = fontMap['*'] || null;

    sendLog('\n--- Fixing fonts ---');
    for (var fi = 0; fi < lastAuditResult.fontMismatches.length; fi++) {
      var fItem = lastAuditResult.fontMismatches[fi];
      var targetFont = fontMap[fItem.font.toLowerCase()] || fallbackFont;
      if (!targetFont) {
        sendLog('  SKIP "' + fItem.font + '" — no mapping', 'info');
        stats.fontSkipped++;
        continue;
      }

      if (dryRun) {
        sendLog('  WOULD FIX ' + fItem.nodeName + ' "' + fItem.font + '" → "' + targetFont + '"', 'ok');
        stats.fontFixed++;
        continue;
      }

      try {
        var fNode = await figma.getNodeByIdAsync(fItem.nodeId);
        if (!fNode || fNode.type !== 'TEXT') throw new Error('not a text node');

        // Try same style, fall back to Regular
        var targetStyle = fItem.style || 'Regular';
        try {
          await figma.loadFontAsync({ family: targetFont, style: targetStyle });
        } catch (e) {
          targetStyle = 'Regular';
          await figma.loadFontAsync({ family: targetFont, style: 'Regular' });
        }
        // Also load source font so Figma can read segments
        try {
          await figma.loadFontAsync({ family: fItem.font, style: fItem.style || 'Regular' });
        } catch (e) { /* best effort */ }

        fNode.fontName = { family: targetFont, style: targetStyle };
        sendLog('  FIXED ' + fItem.nodeName + ' → ' + targetFont + ' ' + targetStyle, 'ok');
        stats.fontFixed++;
      } catch (e) {
        sendLog('  FAIL ' + fItem.nodeName + ' — ' + e.message, 'err');
        stats.fontFailed++;
      }
    }

    // Fix text styles
    if (lastAuditResult.textStyleIssues && lastAuditResult.textStyleIssues.length > 0) {
      sendLog('\n--- Fixing text styles ---');
      for (var ti = 0; ti < lastAuditResult.textStyleIssues.length; ti++) {
        var tItem = lastAuditResult.textStyleIssues[ti];
        var tTarget = fontMap[tItem.font.toLowerCase()] || fallbackFont;
        if (!tTarget) { stats.fontSkipped++; continue; }

        if (dryRun) {
          sendLog('  WOULD FIX text style ' + tItem.styleName + ' → ' + tTarget, 'ok');
          stats.styleFixed++;
          continue;
        }

        try {
          var tStyle = figma.getStyleById(tItem.styleId);
          if (!tStyle) throw new Error('style not found');

          var tsStyle = tItem.style || 'Regular';
          try {
            await figma.loadFontAsync({ family: tTarget, style: tsStyle });
          } catch (e) {
            tsStyle = 'Regular';
            await figma.loadFontAsync({ family: tTarget, style: 'Regular' });
          }
          tStyle.fontName = { family: tTarget, style: tsStyle };
          sendLog('  FIXED text style ' + tItem.styleName + ' → ' + tTarget + ' ' + tsStyle, 'ok');
          stats.styleFixed++;
        } catch (e) {
          sendLog('  FAIL text style ' + tItem.styleName + ' — ' + e.message, 'err');
          stats.styleFailed++;
        }
      }
    }
  }

  // ── Summary ──
  sendLog('\n══════════════════════════════════════════');
  sendLog((dryRun ? 'DRY RUN' : 'FIX') + ' SUMMARY', 'summary');
  sendLog('══════════════════════════════════════════');
  sendLog('Colors:  ' + stats.colorFixed + ' fixed, ' + stats.colorFailed + ' failed, ' + stats.colorSkipped + ' skipped');
  sendLog('Fonts:   ' + stats.fontFixed + ' fixed, ' + stats.fontFailed + ' failed, ' + stats.fontSkipped + ' skipped');
  sendLog('Styles:  ' + stats.styleFixed + ' fixed, ' + stats.styleFailed + ' failed');
  sendLog('Effects: ' + stats.effectFixed + ' fixed, ' + stats.effectFailed + ' failed, ' + stats.effectSkipped + ' skipped');

  var totalFixed = stats.colorFixed + stats.fontFixed + stats.styleFixed + stats.effectFixed;
  var totalFailed = stats.colorFailed + stats.fontFailed + stats.styleFailed + stats.effectFailed;

  if (!dryRun && totalFixed > 0) {
    sendLog('\nRe-run audit to verify results.', 'info');
  }

  figma.ui.postMessage({
    type: 'fix-done',
    stats: stats,
    totalFixed: totalFixed,
    totalFailed: totalFailed,
    dryRun: dryRun,
  });
}

// ──────────────────────────────────────────────
// Message handler
// ──────────────────────────────────────────────
figma.ui.onmessage = function(msg) {
  if (msg.type === 'set-config') {
    config = msg.config;
    lastAuditResult = null; // reset audit when config changes
    sendLog('Config loaded: ' + (config.name || '(unnamed)'), 'ok');

    var cColors = config.detect && config.detect.colors ? Object.keys(config.detect.colors).length : 0;
    var cShadows = config.detect && config.detect.shadowBases ? Object.keys(config.detect.shadowBases).length : 0;
    var cFonts = config.detect && config.detect.fonts ? config.detect.fonts.length : 0;
    var fColors = config.fix && config.fix.colorToVariable ? Object.keys(config.fix.colorToVariable).length : 0;
    var fReplace = config.fix && config.fix.colorReplace ? Object.keys(config.fix.colorReplace).length : 0;
    var fFonts = config.fix && config.fix.fontReplace ? Object.keys(config.fix.fontReplace).length : 0;

    sendLog('  Detect: ' + cColors + ' colors, ' + cShadows + ' shadow bases, ' + cFonts + ' allowed fonts');
    sendLog('  Fix:    ' + fColors + ' color→variable, ' + fReplace + ' color→hex, ' + fFonts + ' font→font');

    figma.ui.postMessage({
      type: 'config-loaded',
      name: config.name || '(unnamed)',
      detectColors: cColors,
      detectShadows: cShadows,
      detectFonts: cFonts,
      fixColors: fColors,
      fixReplace: fReplace,
      fixFonts: fFonts,
    });
  }

  if (msg.type === 'run-audit') {
    runAudit();
  }

  if (msg.type === 'run-fix') {
    runFix(msg.dryRun);
  }
};
