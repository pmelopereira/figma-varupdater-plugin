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

// Pack RGB 0-1 floats into a single 24-bit integer for O(1) numeric comparison
// (avoids expensive hex string building in hot loops)
function colorToKey(c) {
  return ((Math.round(c.r * 255) << 16) | (Math.round(c.g * 255) << 8) | Math.round(c.b * 255));
}

function hexToColorKey(hex) {
  hex = hex.replace('#', '');
  return ((parseInt(hex.slice(0, 2), 16) << 16) |
          (parseInt(hex.slice(2, 4), 16) << 8) |
          parseInt(hex.slice(4, 6), 16));
}

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

// Batched logging — reduces postMessage IPC overhead
var _logBuffer = [];
var _logFlushTimer = null;

function sendLog(text, level) {
  _logBuffer.push({ type: 'log', text: text, level: level || 'info' });
  if (!_logFlushTimer) {
    _logFlushTimer = setTimeout(flushLogs, 0);
  }
}

function flushLogs() {
  _logFlushTimer = null;
  if (_logBuffer.length === 0) return;
  if (_logBuffer.length === 1) {
    figma.ui.postMessage(_logBuffer[0]);
  } else {
    figma.ui.postMessage({ type: 'log-batch', items: _logBuffer });
  }
  _logBuffer = [];
}

function sendProgress(current, total) {
  flushLogs(); // flush pending logs before progress update
  figma.ui.postMessage({ type: 'progress', current: current, total: total });
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
// Uses Map for faster hot-path lookups (like figma-updatevars)
// Also builds numeric-key maps for fast color matching
// ──────────────────────────────────────────────
function buildDetectionMaps() {
  // Map<number (colorKey), {label, hex}> for numeric O(1) lookups in audit loop
  var detectColorKeys = new Map();
  // Map<number, {label, hex}> for shadow base subset
  var detectShadowKeys = new Map();
  var allowedFontsSet = new Set();

  if (config && config.detect) {
    if (config.detect.colors) {
      var keys = Object.keys(config.detect.colors);
      for (var i = 0; i < keys.length; i++) {
        var hex = keys[i];
        var ck = hexToColorKey(hex);
        detectColorKeys.set(ck, { label: config.detect.colors[hex], hex: hex.toLowerCase() });
      }
    }
    if (config.detect.shadowBases) {
      var skeys = Object.keys(config.detect.shadowBases);
      for (var i = 0; i < skeys.length; i++) {
        var shex = skeys[i];
        var sk = hexToColorKey(shex);
        detectShadowKeys.set(sk, { label: config.detect.shadowBases[shex], hex: shex.toLowerCase() });
        // Shadow bases are also flagged as old colors
        detectColorKeys.set(sk, { label: config.detect.shadowBases[shex], hex: shex.toLowerCase() });
      }
    }
    if (config.detect.fonts && Array.isArray(config.detect.fonts)) {
      for (var i = 0; i < config.detect.fonts.length; i++) {
        allowedFontsSet.add(config.detect.fonts[i]);
      }
    }
  }

  return {
    detectColorKeys: detectColorKeys,
    detectShadowKeys: detectShadowKeys,
    allowedFontsSet: allowedFontsSet,
  };
}

// ──────────────────────────────────────────────
// Main Audit  (optimized: iterative traversal, numeric color keys,
//              cached page names, Map lookups, batched logging)
// ──────────────────────────────────────────────
async function runAudit() {
  var maps = buildDetectionMaps();
  var hasColorDetection = maps.detectColorKeys.size > 0;
  var hasFontDetection = maps.allowedFontsSet.size > 0;
  var hasShadowDetection = maps.detectShadowKeys.size > 0;

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

  // ── Iterative traversal (avoids stack overflow on deep trees) ──
  // Also pre-computes page name per node during traversal
  var pages = figma.root.children;
  var allNodes = [];
  var nodePageNames = [];  // parallel array: page name for allNodes[i]

  for (var p = 0; p < pages.length; p++) {
    var pageName = pages[p].name || '(unknown)';
    // BFS with explicit stack — no recursion
    var stack = [pages[p]];
    while (stack.length > 0) {
      var cur = stack.pop();
      allNodes.push(cur);
      nodePageNames.push(pageName);
      if ('children' in cur) {
        var ch = cur.children;
        for (var ci = ch.length - 1; ci >= 0; ci--) {
          stack.push(ch[ci]);
        }
      }
    }
  }

  var nodeCount = allNodes.length;
  issues.totalNodes = nodeCount;
  sendLog('Found ' + nodeCount + ' nodes across ' + pages.length + ' pages');

  var batchSize = 2000; // larger batches = fewer yields, faster overall

  for (var i = 0; i < nodeCount; i++) {
    var node = allNodes[i];

    // --- Fills ---
    var fills = node.fills;
    if (fills && fills !== figma.mixed && fills.length > 0) {
      var bvFills = null;
      if (hasColorDetection || true) { // always needed for binding stats
        try { bvFills = node.boundVariables && node.boundVariables.fills; } catch (e) {}
      }
      for (var f = 0; f < fills.length; f++) {
        var fill = fills[f];
        if (fill.type !== 'SOLID' || fill.visible === false) continue;
        issues.totalWithFills++;

        if (bvFills && bvFills[f]) {
          issues.variableBoundFills++;
        } else {
          issues.unboundFills++;
          if (hasColorDetection) {
            var fKey = colorToKey(fill.color);
            var fMatch = maps.detectColorKeys.get(fKey);
            if (fMatch) {
              issues.hardcodedOldColors.push({
                nodeId: node.id, nodeName: node.name, page: nodePageNames[i],
                property: 'fill', paintIndex: f, hex: fMatch.hex,
                oldName: fMatch.label,
              });
            }
          }
        }
      }
    }

    // --- Strokes ---
    var strokes = node.strokes;
    if (strokes && strokes !== figma.mixed && strokes.length > 0) {
      var bvStrokes = null;
      try { bvStrokes = node.boundVariables && node.boundVariables.strokes; } catch (e) {}
      for (var s = 0; s < strokes.length; s++) {
        var stroke = strokes[s];
        if (stroke.type !== 'SOLID' || stroke.visible === false) continue;
        issues.totalWithStrokes++;

        if (bvStrokes && bvStrokes[s]) {
          issues.variableBoundStrokes++;
        } else {
          issues.unboundStrokes++;
          if (hasColorDetection) {
            var sKey = colorToKey(stroke.color);
            var sMatch = maps.detectColorKeys.get(sKey);
            if (sMatch) {
              issues.hardcodedOldColors.push({
                nodeId: node.id, nodeName: node.name, page: nodePageNames[i],
                property: 'stroke', paintIndex: s, hex: sMatch.hex,
                oldName: sMatch.label,
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
            if (!maps.allowedFontsSet.has(fontName.family)) {
              issues.fontMismatches.push({
                nodeId: node.id, nodeName: node.name, page: nodePageNames[i],
                font: fontName.family, style: fontName.style,
                expected: Array.from(maps.allowedFontsSet).join(', '),
              });
            }
          }
        } catch (e) { /* mixed fonts — skip */ }
      }
    }

    if ((i + 1) % batchSize === 0) {
      sendProgress(i + 1, nodeCount);
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
          var pKey = colorToKey(paint.color);
          var pMatch = maps.detectColorKeys.get(pKey);
          if (pMatch) {
            styleIssues.paint.push({
              styleId: pStyle.id, styleName: pStyle.name,
              paintIndex: sp, hex: pMatch.hex, oldName: pMatch.label,
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
            !maps.allowedFontsSet.has(tStyle.fontName.family)) {
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
          var eKey = colorToKey(eff.color);
          var eMatch = maps.detectShadowKeys.get(eKey);
          if (eMatch) {
            styleIssues.effect.push({
              styleId: eStyle.id, styleName: eStyle.name,
              effectIndex: ef, hex: eMatch.hex, oldName: eMatch.label,
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

  flushLogs(); // ensure all buffered logs are sent before done message
  figma.ui.postMessage({
    type: 'audit-done',
    summary: summaryData,
    canFix: hasFixConfig && totalIssues > 0,
  });
}

// ──────────────────────────────────────────────
// Fix All  (optimized: batch by node, O(1) variable
//           lookup, throttled logging, yielded batches)
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

  // Build color maps (Map for O(1) lookups, matching figma-updatevars pattern)
  var colorMap = new Map();
  if (config.fix.colorToVariable) {
    var ctv = config.fix.colorToVariable;
    var ctvKeys = Object.keys(ctv);
    for (var ci = 0; ci < ctvKeys.length; ci++) {
      colorMap.set(ctvKeys[ci].toLowerCase(), ctv[ctvKeys[ci]]);
    }
  }
  var hexReplace = new Map();
  if (config.fix.colorReplace) {
    var cr = config.fix.colorReplace;
    var crKeys = Object.keys(cr);
    for (var ci2 = 0; ci2 < crKeys.length; ci2++) {
      hexReplace.set(crKeys[ci2].toLowerCase(), cr[crKeys[ci2]].toLowerCase());
    }
  }
  var hasColorFix = colorMap.size > 0 || hexReplace.size > 0;

  // ── Fix hardcoded colors → bind to variables or replace hex ──
  if (hasColorFix) {

    // Load all COLOR variables and build O(1) lookup maps (Map, like figma-updatevars)
    var allVars = await figma.variables.getLocalVariablesAsync('COLOR');
    var varByName = new Map();   // exact name → variable
    for (var vi = 0; vi < allVars.length; vi++) {
      varByName.set(allVars[vi].name, allVars[vi]);
    }
    sendLog('Loaded ' + allVars.length + ' color variables (indexed)');

    // Variable lookup: O(1) exact, O(n) substring fallback with cache
    var varCache = new Map();  // targetName → variable (memoize)
    function findVariable(targetName) {
      if (varCache.has(targetName)) return varCache.get(targetName);
      // Exact match
      var exact = varByName.get(targetName);
      if (exact) {
        varCache.set(targetName, exact);
        return exact;
      }
      // Substring fallback
      for (var j = 0; j < allVars.length; j++) {
        if (allVars[j].name.indexOf(targetName) !== -1) {
          varCache.set(targetName, allVars[j]);
          return allVars[j];
        }
      }
      varCache.set(targetName, null);
      return null;
    }

    // Pre-resolve all unique hex → variable/replacement ONCE
    var resolvedVars = new Map();   // hex → variable | null
    var resolvedHex = new Map();    // hex → replacement hex | null
    var uniqueHexes = new Set();
    var hcColors = lastAuditResult.hardcodedOldColors;
    for (var ui = 0; ui < hcColors.length; ui++) {
      uniqueHexes.add(hcColors[ui].hex);
    }
    uniqueHexes.forEach(function(hex) {
      var targetName = colorMap.get(hex);
      resolvedVars.set(hex, targetName ? findVariable(targetName) : null);
      resolvedHex.set(hex, hexReplace.get(hex) || null);
    });
    sendLog('Pre-resolved ' + uniqueHexes.size + ' unique colors');

    // ── Group fixes by nodeId so we fetch each node ONCE ──
    var byNode = new Map();
    for (var gi = 0; gi < hcColors.length; gi++) {
      var gItem = hcColors[gi];
      if (!resolvedVars.get(gItem.hex) && !resolvedHex.get(gItem.hex)) {
        stats.colorSkipped++;
        continue;
      }
      var arr = byNode.get(gItem.nodeId);
      if (!arr) { arr = []; byNode.set(gItem.nodeId, arr); }
      arr.push(gItem);
    }

    var totalItems = hcColors.length - stats.colorSkipped;
    sendLog('\n--- Fixing node colors: ' + totalItems + ' fixes across ' + byNode.size + ' unique nodes ---');

    if (stats.colorSkipped > 0) {
      sendLog('  SKIPPED ' + stats.colorSkipped + ' — no mapping', 'info');
    }

    // Process nodes in batches, yielding to keep Figma responsive
    var FIX_BATCH = 200;
    var fixCount = 0;
    var logBuf = [];

    function flushFixLogs() {
      if (logBuf.length > 0) {
        // Send batched log as a single summary line
        var ok = 0, fail = 0;
        for (var li = 0; li < logBuf.length; li++) { if (logBuf[li].ok) ok++; else fail++; }
        if (ok > 0) sendLog('  ✓ ' + ok + ' fixes applied in batch', 'ok');
        if (fail > 0) sendLog('  ✗ ' + fail + ' failures in batch', 'err');
        logBuf = [];
      }
    }

    var nodeEntries = Array.from(byNode.entries());
    for (var ni = 0; ni < nodeEntries.length; ni++) {
      var nid = nodeEntries[ni][0];
      var fixes = nodeEntries[ni][1];

      if (dryRun) {
        // Dry run: just count, no node fetch needed
        for (var di = 0; di < fixes.length; di++) {
          stats.colorFixed++;
        }
        fixCount += fixes.length;
        if (fixCount % (FIX_BATCH * 5) === 0) {
          sendProgress(fixCount, totalItems);
        }
        continue;
      }

      try {
        var node = await figma.getNodeByIdAsync(nid);
        if (!node) throw new Error('node not found: ' + nid);

        // Separate fills and strokes for this node
        var fillFixes = [];
        var strokeFixes = [];
        for (var fi2 = 0; fi2 < fixes.length; fi2++) {
          if (fixes[fi2].property === 'fill') fillFixes.push(fixes[fi2]);
          else strokeFixes.push(fixes[fi2]);
        }

        // Apply all fill fixes in one write
        if (fillFixes.length > 0 && 'fills' in node) {
          var fills = JSON.parse(JSON.stringify(node.fills));
          for (var ff = 0; ff < fillFixes.length; ff++) {
            var ffix = fillFixes[ff];
            var fVar = resolvedVars.get(ffix.hex);
            try {
              if (fVar) {
                fills[ffix.paintIndex] = figma.variables.setBoundVariableForPaint(
                  fills[ffix.paintIndex], 'color', fVar
                );
              } else {
                fills[ffix.paintIndex].color = hexToRgb01(resolvedHex.get(ffix.hex));
              }
              stats.colorFixed++;
              logBuf.push({ ok: true });
            } catch (e) {
              stats.colorFailed++;
              logBuf.push({ ok: false });
            }
          }
          node.fills = fills;
        }

        // Apply all stroke fixes in one write
        if (strokeFixes.length > 0 && 'strokes' in node) {
          var strokes = JSON.parse(JSON.stringify(node.strokes));
          for (var ss = 0; ss < strokeFixes.length; ss++) {
            var sfix = strokeFixes[ss];
            var sVar = resolvedVars.get(sfix.hex);
            try {
              if (sVar) {
                strokes[sfix.paintIndex] = figma.variables.setBoundVariableForPaint(
                  strokes[sfix.paintIndex], 'color', sVar
                );
              } else {
                strokes[sfix.paintIndex].color = hexToRgb01(resolvedHex.get(sfix.hex));
              }
              stats.colorFixed++;
              logBuf.push({ ok: true });
            } catch (e) {
              stats.colorFailed++;
              logBuf.push({ ok: false });
            }
          }
          node.strokes = strokes;
        }

      } catch (e) {
        // Entire node failed — count all its fixes as failed
        for (var ef2 = 0; ef2 < fixes.length; ef2++) {
          stats.colorFailed++;
          logBuf.push({ ok: false });
        }
      }

      fixCount += fixes.length;

      // Yield every FIX_BATCH nodes + send progress + flush logs
      if ((ni + 1) % FIX_BATCH === 0) {
        flushFixLogs();
        sendProgress(fixCount, totalItems);
        await new Promise(function(r) { setTimeout(r, 0); });
      }
    }
    flushFixLogs();

    if (dryRun) {
      sendLog('  WOULD FIX ' + stats.colorFixed + ' colors across ' + byNode.size + ' nodes', 'ok');
    }

    // Fix paint styles
    if (lastAuditResult.paintStyleIssues.length > 0) {
      sendLog('\n--- Fixing paint styles (' + lastAuditResult.paintStyleIssues.length + ') ---');
      for (var pi = 0; pi < lastAuditResult.paintStyleIssues.length; pi++) {
        var pItem = lastAuditResult.paintStyleIssues[pi];

        var pVar = resolvedVars.get(pItem.hex);
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

        var pReplHex = resolvedHex.get(pItem.hex);
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
        var eReplHex = hexReplace.get(eItem.hex);
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

    // Pre-load all target fonts once
    var loadedFonts = {};
    sendLog('\n--- Fixing fonts ---');

    async function ensureFont(family, style) {
      var key = family + '|' + style;
      if (loadedFonts[key]) return style;
      try {
        await figma.loadFontAsync({ family: family, style: style });
        loadedFonts[key] = true;
        return style;
      } catch (e) {
        var fallStyle = 'Regular';
        var fkey = family + '|' + fallStyle;
        if (!loadedFonts[fkey]) {
          await figma.loadFontAsync({ family: family, style: fallStyle });
          loadedFonts[fkey] = true;
        }
        return fallStyle;
      }
    }

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

        var actualStyle = await ensureFont(targetFont, fItem.style || 'Regular');
        // Also load source font so Figma can read segments
        try {
          await figma.loadFontAsync({ family: fItem.font, style: fItem.style || 'Regular' });
        } catch (e) { /* best effort */ }

        fNode.fontName = { family: targetFont, style: actualStyle };
        stats.fontFixed++;
      } catch (e) {
        sendLog('  FAIL ' + fItem.nodeName + ' — ' + e.message, 'err');
        stats.fontFailed++;
      }

      if ((fi + 1) % FIX_BATCH === 0) {
        sendLog('  Fonts: ' + stats.fontFixed + '/' + lastAuditResult.fontMismatches.length, 'ok');
        await new Promise(function(r) { setTimeout(r, 0); });
      }
    }
    if (stats.fontFixed > 0) {
      sendLog('  Fixed ' + stats.fontFixed + ' font nodes', 'ok');
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

          var tActualStyle = await ensureFont(tTarget, tItem.style || 'Regular');
          tStyle.fontName = { family: tTarget, style: tActualStyle };
          sendLog('  FIXED text style ' + tItem.styleName + ' → ' + tTarget + ' ' + tActualStyle, 'ok');
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

  flushLogs(); // ensure all buffered logs are sent before done message
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
