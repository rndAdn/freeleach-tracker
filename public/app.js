// ── Toggle / MaxSize ──────────────────────────────────────────────────────────
async function toggle(name) {
    await fetch('/api/toggle/' + encodeURIComponent(name), {method: 'POST'});
    location.reload();
}

async function setMaxSize(name, value) {
    await fetch('/api/maxsize/' + encodeURIComponent(name), {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({maxSizeGb: parseInt(value)})
    });
}

// ── Category panel ────────────────────────────────────────────────────────────
// excluded: Map<trackerName, Set<number>>
const _excluded = {};
Object.entries(window._excluded).forEach(([name, ids]) => {
    _excluded[name] = new Set(ids);
});

function isExcluded(name, id) {
    return _excluded[name] && _excluded[name].has(id);
}

function isFamilyExcluded(name, id) {
    return _excluded[name] && _excluded[name].has(Math.floor(id / 1000) * 1000);
}

function getParentState(name, cat) {
    // coché = famille exclue OU toutes sous-cats exclues
    if (isExcluded(name, cat.id)) return 'checked';
    const subs = cat.subCategories || [];
    if (subs.length === 0) return isExcluded(name, cat.id) ? 'checked' : 'unchecked';
    const excludedSubs = subs.filter(s => isExcluded(name, s.id) || isFamilyExcluded(name, s.id)).length;
    if (excludedSubs === 0) return 'unchecked';
    if (excludedSubs === subs.length) return 'checked';
    return 'indeterminate';
}

async function saveExclusions(name) {
    const ids = [...(_excluded[name] || new Set())];
    await fetch('/api/categories/' + encodeURIComponent(name), {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({excludedCategories: ids})
    });
}

function onParentCheck(name, catId, checked, subIds, panelEl) {
    if (!_excluded[name]) _excluded[name] = new Set();
    if (checked) {
        _excluded[name].add(catId);
        subIds.forEach(id => _excluded[name].delete(id)); // famille couvre tout
    } else {
        _excluded[name].delete(catId);
        subIds.forEach(id => _excluded[name].delete(id));
    }
    saveExclusions(name);
    renderCatPanel(name, panelEl);
    updateCatButton(name);
}

function onSubCheck(name, subId, parentId, checked, allSubIds, panelEl) {
    if (!_excluded[name]) _excluded[name] = new Set();
    // Si la famille était exclue, on explose en sous-cats individuelles
    if (_excluded[name].has(parentId)) {
        _excluded[name].delete(parentId);
        allSubIds.forEach(id => _excluded[name].add(id));
    }
    if (checked) _excluded[name].add(subId);
    else _excluded[name].delete(subId);
    saveExclusions(name);
    renderCatPanel(name, panelEl);
    updateCatButton(name);
}

function updateCatButton(name) {
    const count = _excluded[name] ? _excluded[name].size : 0;
    const rows = document.querySelectorAll('#row-' + CSS.escape(name) + ' .btn-cat');
    rows.forEach(btn => {
        const badge = count > 0 ? ' <span class="badge-excl">' + count + '</span>' : '';
        btn.innerHTML = 'Catégories' + badge;
    });
}

function renderCatPanel(name, panelEl) {
    const cats = window._categories[name] || [];
    const standard = cats.filter(c => c.id < 100000);
    const custom = cats.filter(c => c.id >= 100000);

    function buildTree(list) {
        return list.map(cat => {
            const subs = cat.subCategories || [];
            const subIds = subs.map(s => s.id);
            const state = getParentState(name, cat);
            const cbId = 'cb-' + name + '-' + cat.id;

            let subsHtml = '';
            if (subs.length > 0) {
                subsHtml = '<ul class="sub-list">' + subs.map(sub => {
                    const subChecked = isExcluded(name, sub.id) || isExcluded(name, cat.id);
                    const subCbId = 'cb-' + name + '-' + sub.id;
                    return '<li><label><input type="checkbox" id="' + subCbId + '" ' + (subChecked ? 'checked' : '') +
                        ' onchange="onSubCheck(' + JSON.stringify(name) + ',' + sub.id + ',' + cat.id + ',this.checked,' + JSON.stringify(subIds) + ',this.closest(&quot;.cat-inner&quot;))"> ' +
                    sub.name + '</label></li>';
                }).join('') + '</ul>';
            }

            return '<li class="parent-item"><label><input type="checkbox" id="' + cbId + '" ' +
                (state === 'checked' ? 'checked' : '') +
                ' onchange="onParentCheck(' + JSON.stringify(name) + ',' + cat.id + ',this.checked,' + JSON.stringify(subIds) + ',this.closest(&quot;.cat-inner&quot;))"> ' +
            cat.name + (cat.id < 100000 ? ' <span style="color:#484f58;font-size:.75rem">(' + cat.id + ')</span>' : '') +
            '</label>' + subsHtml + '</li>';
        }).join('');
    }

    let html = '';
    if (standard.length > 0) {
        html += '<div class="cat-section"><h3>Newznab standard</h3><ul class="cat-tree">' + buildTree(standard) + '</ul></div>';
    }
    if (custom.length > 0) {
        html += '<div class="cat-section"><h3>Catégories custom</h3><ul class="cat-tree">' + buildTree(custom) + '</ul></div>';
    }
    panelEl.innerHTML = html;

    // Appliquer l'état indéterminé après rendu
    panelEl.querySelectorAll('input[type=checkbox]').forEach(cb => {
        const idMatch = cb.id.match(/cb-[^-]+-(\d+)$/);
        if (!idMatch) return;
        const catId = parseInt(idMatch[1]);
        const cat = (window._categories[name] || []).find(c => c.id === catId);
        if (cat && (cat.subCategories || []).length > 0) {
            const s = getParentState(name, cat);
            if (s === 'indeterminate') {
                cb.checked = false;
                cb.indeterminate = true;
            }
        }
    });
}

function toggleCatPanel(name) {
    const row = document.getElementById('cat-' + name);
    const panel = row.querySelector('.cat-panel');
    if (row.style.display === 'none') {
        row.style.display = '';
        renderCatPanel(name, panel);
    } else {
        row.style.display = 'none';
    }
}

// ── Logs ──────────────────────────────────────────────────────────────────────
const TRACKER_COLORS = window._tc;

function formatLine(entry) {
    const ts = entry.ts, msg = entry.msg;
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let cls = 'log-info';
    if (msg.includes('\u2713')) cls = 'log-ok';
    else if (msg.includes('\u2717')) cls = 'log-fail';
    else if (msg.includes('~')) cls = 'log-skip';
    else if (msg.includes('No new') || msg.includes('No trackers')) cls = 'log-quiet';
    let escaped = esc(msg);
    Object.entries(TRACKER_COLORS).forEach(function (e) {
        escaped = escaped.split('[' + e[0] + ']').join('[<span style="color:' + e[1] + ';font-weight:700">' + e[0] + '</span>]');
    });
    return '<div><span class="log-time">[' + ts + ']</span> <span class="' + cls + '">' + escaped + '</span></div>';
}

async function refreshLogs() {
    const res = await fetch('/api/logs');
    const lines = await res.json();
    const el = document.getElementById('logs');
    const wasBottom = el.scrollHeight - el.clientHeight <= el.scrollTop + 10;
    el.innerHTML = lines.map(formatLine).join('');
    if (wasBottom) el.scrollTop = el.scrollHeight;
}

refreshLogs();
setInterval(refreshLogs, 3000);
