const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const paths = {
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 11-2l3 3M4 16l3 3a7 7 0 0 0 11-2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  left: '<path d="m15 6-6 6 6 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  link: '<path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(0 1) scale(.92)"/>',
  folder: '<path d="M3 7V5h6l2 2h10v13H3V7Z"/>',
  file: '<path d="M6 3h8l4 4v14H6V3ZM14 3v5h4M9 12h6M9 16h6"/>',
  code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`;
document.querySelectorAll('[data-icon]').forEach((element) => { element.innerHTML = icon(element.dataset.icon); });
const initial = new URLSearchParams(location.search);
let tab = ['library', 'agents', 'workspaces', 'activity', 'help'].includes(initial.get('tab')) ? initial.get('tab') : 'library';
let state;
let selected = initial.get('skill');
let detail;
let detailTab = 'instructions';
let registrationKind = 'workspace';
let editingAgent;
let currentPage = Math.max(1, Number(initial.get('page')) || 1);
let editing = false;
let detailRequest = 0;
let removalDetail;
const pageSize = 10;

function setEditing(value) {
  editing = value;
  for (const selector of ['#search', '#scope', '#source']) $(selector).disabled = value;
}

function shortPath(value) {
  return state && value?.startsWith(`${state.home}/`) ? `~/${value.slice(state.home.length + 1)}` : value;
}
function initials(name) {
  return name === 'Shared library' ? 'SL' : name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}
function notify(message, error = false) {
  const notice = $('#notice');
  notice.textContent = message;
  notice.classList.toggle('error', error);
  notice.hidden = false;
}
async function api(url, data) {
  const response = await fetch(url, data === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Skills-Token': state?.token || '' },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}
async function busy(button, action) {
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try { return await action(); }
  finally { button.disabled = false; button.removeAttribute('aria-busy'); }
}
function updateURL() {
  const parameters = new URLSearchParams();
  if (tab !== 'library') parameters.set('tab', tab);
  if ($('#search').value) parameters.set('q', $('#search').value);
  if ($('#scope').value) parameters.set('scope', $('#scope').value);
  if ($('#source').value) parameters.set('source', $('#source').value);
  if (selected) parameters.set('skill', selected);
  if (currentPage > 1) parameters.set('page', currentPage);
  history.replaceState(null, '', `/${parameters.size ? `?${parameters}` : ''}${tab === 'help' ? location.hash : ''}`);
}
function setTab(next) {
  if (editing && !confirm('Discard unsaved skill edits?')) return false;
  setEditing(false);
  tab = next;
  const headings = {
    library: ['A home for your skills.', 'Find them once. Put them to work in every agent.', 'Add workspace'],
    agents: ['Different agents. Shared knowledge.', 'Give every agent access to the skills you already trust.', 'Add agent'],
    workspaces: ['Keep your skills in view.', 'Bring repository knowledge beyond a single workspace.', 'Add workspace'],
    activity: ['Know what went where.', 'Sharing, removal, and recovery, recorded locally.', 'Share a skill'],
    help: ['Know your skills dashboard.', 'Plain answers about folders, sharing, and what the app actually does.', 'Browse library'],
  };
  const [title, description, action] = headings[tab];
  $('#page-title').textContent = title;
  $('#page-description').textContent = description;
  $('#add-source').innerHTML = `${icon(tab === 'activity' ? 'link' : 'plus')}${action}`;
  const pageHelp = {
    library: ['A combined inventory, not another storage folder. Select a skill to view, share, edit, or remove a specific location.', 'terms'],
    agents: ['Each entry is a named folder configuration. Existing paths are evidence only, not verified agent installations or skill support.', 'detection'],
    workspaces: ['Register a repository or skills folder. Discover folders suggests other repositories; Rescan only refreshes registered locations.', 'discovery'],
    activity: ['See recent changes, disconnect managed links, and restore removed locations. Source files are not deleted when unlinking.', 'removal'],
    help: ['Start here for page documentation, terminology, architecture, folder layouts, and troubleshooting.', 'pages'],
  };
  $('#page-help-text').textContent = pageHelp[tab][0];
  $('#page-help-link').dataset.help = pageHelp[tab][1];
  $('#page-help-link').href = `/?tab=help#${pageHelp[tab][1]}`;
  $('#page-help').open = false;
  $('#overview').hidden = tab === 'help';
  for (const name of Object.keys(headings)) $(`#${name}-view`).hidden = name !== tab;
  document.querySelectorAll('nav a').forEach((element) => {
    if (element.dataset.tab === tab) element.setAttribute('aria-current', 'page');
    else element.removeAttribute('aria-current');
  });
  $('#registration').hidden = true;
  updateURL();
  if (tab === 'library' && state) renderLibrary();
  return true;
}

function openHelp(topic) {
  if (!setTab('help')) return;
  const answer = document.getElementById(topic);
  if (!answer?.classList.contains('faq')) return;
  answer.open = true;
  history.replaceState(null, '', `${location.pathname}${location.search}#${topic}`);
  answer.scrollIntoView({ block: 'start' });
  answer.querySelector('summary').focus({ preventScroll: true });
}

async function refresh() {
  const firstLoad = !state;
  const result = await api('/api/state');
  state = result;
  $('#skill-count').textContent = state.skills.length;
  $('#agent-count').textContent = state.agents.filter((agent) => agent.id !== 'shared' && agent.detected).length;
  $('#workspace-count').textContent = state.workspaces.length;
  $('#link-count').textContent = state.skills.flatMap((skill) => skill.locations).filter((entry) => entry.linked).length;
  $('#scan-time').textContent = `Scanned ${new Date(state.scannedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  $('#runtime-info').textContent = `${Math.round(state.memoryBytes / 1024 / 1024)} MiB server RSS / no background watcher`;
  $('#warnings').hidden = !state.warnings.length;
  $('#warning-summary').textContent = `${state.warnings.length} folder${state.warnings.length === 1 ? '' : 's'} need attention`;
  $('#warning-list').innerHTML = state.warnings.map((warning) => `<li>${escapeHTML(warning)}</li>`).join('');
  const sourceValue = $('#source').value || (firstLoad ? initial.get('source') : '') || '';
  $('#source').innerHTML = '<option value="">All sources</option>' + [...state.agents, ...state.workspaces].map((owner) => `<option value="${escapeHTML(owner.id)}">${escapeHTML(owner.name)}</option>`).join('');
  $('#source').value = sourceValue;
  renderLibrary();
  renderAgents();
  renderWorkspaces();
  renderActivity();
}

function filteredSkills() {
  const query = $('#search').value.toLowerCase().trim();
  const scope = $('#scope').value;
  const source = $('#source').value;
  return state.skills.filter((skill) => `${skill.name} ${skill.description} ${skill.path}`.toLowerCase().includes(query)
    && skill.locations.some((entry) => (!scope || entry.scope === scope) && (!source || entry.ownerId === source)));
}
function renderLibrary() {
  if (!state) return;
  const skills = filteredSkills();
  currentPage = Math.min(currentPage, Math.max(1, Math.ceil(skills.length / pageSize)));
  const start = (currentPage - 1) * pageSize;
  const visible = skills.slice(start, start + pageSize);
  $('#filtered-count').textContent = skills.length;
  $('#page-range').textContent = skills.length ? `${start + 1}–${Math.min(start + pageSize, skills.length)} of ${skills.length} skills` : '0 skills';
  $('#previous-page').disabled = currentPage <= 1;
  $('#next-page').disabled = start + pageSize >= skills.length;
  if (!skills.length) {
    $('#skills-body').innerHTML = `<tr class="empty-row"><td colspan="4"><div class="empty-state"><h3>${state.skills.length ? 'No matching skills.' : 'Your library starts here.'}</h3><p>${state.skills.length ? 'Try another search or clear your filters.' : 'Add a workspace or configure an agent’s skills folder.'}</p><button class="button quiet" data-action="${state.skills.length ? 'clear-filters' : 'add-workspace'}">${state.skills.length ? 'Clear filters' : 'Add workspace'}</button></div></td></tr>`;
  } else {
    $('#skills-body').innerHTML = visible.map((skill) => {
      const source = skill.locations.find((entry) => !entry.linked) || skill.locations[0];
      const agents = [...new Map(skill.locations.filter((entry) => entry.scope === 'system').map((entry) => [entry.ownerId, entry])).values()];
      return `<tr class="${skill.id === selected ? 'selected' : ''}"><td><div class="skill-cell"><span class="skill-symbol">${icon('code')}</span><div><button class="skill-name" data-skill="${skill.id}" aria-pressed="${skill.id === selected}">${escapeHTML(skill.name)}</button><p class="skill-description" title="${escapeHTML(skill.description)}">${escapeHTML(skill.description)}</p></div></div></td><td><span class="source-name" title="${escapeHTML(source.path)}">${escapeHTML(source.ownerName)}</span><span class="scope-label">${source.scope === 'system' ? 'System level' : 'Workspace level'}</span></td><td><div class="agent-stack">${agents.length ? agents.slice(0, 3).map((entry) => `<span class="agent-badge" title="${escapeHTML(entry.ownerName)}">${escapeHTML(initials(entry.ownerName))}</span>`).join('') + (agents.length > 3 ? `<span class="muted small">+${agents.length - 3}</span>` : '') : '<span class="muted small">Workspace only</span>'}</div></td><td><button class="icon-button" data-skill="${skill.id}" aria-label="Inspect ${escapeHTML(skill.name)}">${icon('right')}</button></td></tr>`;
    }).join('');
  }
  if (!selected || !skills.some((skill) => skill.id === selected)) {
    if (!editing) {
      selected = visible[0]?.id || null;
      if (selected) {
        renderLibrary();
        return;
      }
      detail = null;
      $('#inspector').innerHTML = `<div class="empty-detail">${icon('layers')}<h2>A little more context.</h2><p>${state.skills.length ? 'Clear your filters to choose a skill.' : 'Add a workspace to inspect its skills here.'}</p></div>`;
    }
  }
  updateURL();
  if (selected && !editing) loadDetail(selected);
}
async function loadDetail(id) {
  const request = ++detailRequest;
  $('#inspector').setAttribute('aria-busy', 'true');
  try {
    const result = await api(`/api/skill?id=${encodeURIComponent(id)}`);
    if (request !== detailRequest || selected !== id || editing) return;
    detail = result;
    renderDetail();
  } catch (error) {
    if (request === detailRequest) $('#inspector').innerHTML = `<div class="empty-detail"><h2>Could not read this skill.</h2><p role="alert">${escapeHTML(error.message)}</p><button class="button quiet" data-action="retry-detail">Retry</button></div>`;
  } finally {
    if (request === detailRequest) $('#inspector').removeAttribute('aria-busy');
  }
}
function renderDetail() {
  if (!detail) return;
  setEditing(false);
  const owners = [...new Set(detail.locations.map((entry) => entry.ownerName))];
  $('#inspector').innerHTML = `<div class="inspector-header"><span>Skill details</span>${icon('layers')}</div>
    <h2>${escapeHTML(detail.name)}</h2><p class="detail-description">${escapeHTML(detail.description)}</p>
    <hr class="detail-rule"><span class="detail-label">Source folder</span><code class="path source-path">${escapeHTML(shortPath(detail.path))}</code>
    <span class="detail-label">Available in</span><div class="detail-pills">${owners.map((owner) => `<span>${escapeHTML(owner)}</span>`).join('')}</div>
    <button class="button primary" data-action="share">${icon('link')}Share with agents</button>
    <div class="detail-tools"><a href="/?tab=help#links" data-help="links">${icon('info')}How sharing works</a><button class="text-button" data-action="remove-skill">Remove skill</button></div>
    <div class="detail-tabs"><button data-detail-tab="instructions" aria-pressed="${detailTab === 'instructions'}">Instructions</button><button data-detail-tab="files" aria-pressed="${detailTab === 'files'}">Files (${detail.files.length})</button></div>
    <div id="detail-content">${detailTab === 'files' ? `<ul class="file-list">${detail.files.map((file) => `<li>${icon(file.directory ? 'folder' : 'file')}<span>${escapeHTML(file.name)}${file.linked ? ' (link)' : ''}</span></li>`).join('')}</ul>` : '<pre class="document-preview" id="document-preview"></pre><div class="edit-actions"><span class="muted small">SKILL.md</span><button class="text-button" data-action="edit">Edit instructions</button></div>'}</div>`;
  if ($('#document-preview')) $('#document-preview').textContent = detail.document;
}

function renderAgents() {
  $('#agents-body').innerHTML = state.agents.map((agent) => `<tr><td><div class="agent-title"><span class="agent-badge">${escapeHTML(initials(agent.name))}</span><div><strong>${escapeHTML(agent.name)}</strong><p class="agent-note">${escapeHTML(agent.note)}</p><p class="evidence small">${agent.detected ? 'Path found' : 'Path not found'}: <code class="path">${escapeHTML(shortPath(agent.evidencePath))}</code></p></div></div></td><td><code class="path">${escapeHTML(shortPath(agent.path) || 'Not configured')}</code></td><td class="num">${agent.count}</td><td><span class="status ${agent.skillsFolderExists ? 'ready' : ''}">${!agent.path ? 'Needs skills folder' : agent.skillsFolderExists ? 'Skills path found' : 'Skills path missing'}</span></td><td><div class="row-actions"><button class="text-button" data-configure="${escapeHTML(agent.id)}">Configure</button>${!agent.builtin ? `<button class="icon-button" data-remove-agent="${agent.id}" aria-label="Remove ${escapeHTML(agent.name)} registration">${icon('close')}</button>` : ''}</div></td></tr>`).join('');
}
function renderWorkspaces() {
  $('#workspaces-body').innerHTML = state.workspaces.length ? state.workspaces.map((workspace) => `<tr><td><div class="agent-title">${icon('folder')}<strong>${escapeHTML(workspace.name)}</strong></div>${!workspace.available ? '<span class="status">Folder not found</span>' : ''}</td><td><code class="path">${escapeHTML(shortPath(workspace.path))}</code></td><td class="num">${workspace.count}</td><td><button class="text-button" data-remove-workspace="${workspace.id}">Remove registration</button></td></tr>`).join('') : '<tr><td colspan="4"><div class="empty-state"><h3>No workspaces registered.</h3><p>Add a repository to discover its workspace skills.</p></div></td></tr>';
}
function renderActivity() {
  const methods = { link: 'Source link', copy: 'Independent copy', 'remove-link': 'Removed link', 'remove-skill': 'Removed skill', restore: 'Restored location' };
  $('#activity-body').innerHTML = state.activity.length ? state.activity.map((event) => `<tr><td><strong>${escapeHTML(event.skill)}</strong><p class="muted small">${escapeHTML(event.agent)}</p><code class="path">${escapeHTML(shortPath(event.destination))}</code></td><td>${escapeHTML(methods[event.mode] || event.mode)}${event.undone ? '<span class="scope-label">Disconnected</span>' : ''}</td><td class="muted">${escapeHTML(new Date(event.at).toLocaleString())}</td><td>${event.mode === 'link' && !event.undone ? `<button class="text-button" data-unlink="${event.id}">Disconnect link</button>` : '<span class="muted">—</span>'}</td></tr>`).join('') : '<tr><td colspan="4"><div class="empty-state"><h3>No changes recorded yet.</h3><p>Choose a skill in your library to share or manage it.</p><button class="button quiet" data-action="library">Browse library</button></div></td></tr>';
  $('#recovery').hidden = !state.removed.length;
  $('#recovery-body').innerHTML = state.removed.map((event) => `<tr><td>${escapeHTML(event.skill)}<span class="scope-label">${event.mode === 'remove-link' ? 'Link only' : 'Skill directory'}</span></td><td><code class="path">${escapeHTML(shortPath(event.source))}</code></td><td><button class="button quiet" data-restore="${escapeHTML(event.id)}">Restore</button></td></tr>`).join('');
}

function removalImpact() {
  const location = removalDetail.locations.find((entry) => entry.path === $('#remove-location').value);
  const blocked = !location.linked && removalDetail.locations.some((entry) => entry.path !== location.path);
  $('#remove-impact').textContent = location.linked
    ? 'Only this symbolic link will be removed. Its source files and other locations stay untouched.'
    : blocked ? 'Other registered locations use this source. Remove those links or registrations first; source removal will be refused.'
      : 'This whole skill directory will move out of its current location into recovery storage. Agents will no longer find it at this path.';
}
function openRemoval() {
  removalDetail = detail;
  $('#remove-form').reset();
  $('#remove-error').textContent = '';
  $('#remove-confirm-name').textContent = detail.name;
  $('#remove-location').innerHTML = [...new Map(detail.locations.map((entry) => [entry.path, entry])).values()].map((entry) => `<option value="${escapeHTML(entry.path)}">${escapeHTML(entry.ownerName)} (${entry.linked ? 'link' : 'directory'}): ${escapeHTML(shortPath(entry.path))}</option>`).join('');
  removalImpact();
  $('#remove-dialog').showModal();
}

function openRegistration(kind, agent) {
  registrationKind = kind;
  editingAgent = agent?.id;
  $('#registration-form').reset();
  const isAgent = kind === 'agent';
  $('#registration-title').textContent = agent ? `Configure ${agent.name}` : isAgent ? 'Add an agent' : 'Add a workspace';
  $('#agent-name-label').hidden = !isAgent;
  $('#registration-form').elements.name.required = isAgent;
  $('#registration-form').elements.name.value = agent?.name || '';
  $('#registration-form').elements.path.value = agent?.path || '';
  $('#registration-form').elements.path.placeholder = isAgent ? '~/.sahaa/skills' : '~/projects/logs_fw';
  $('#path-label').textContent = isAgent ? 'Agent skills folder' : 'Repository or skills folder';
  $('#path-help').textContent = isAgent ? 'Use the exact folder your agent reads. It is created only when you share a skill.' : 'Looks in .agents/skills, .github/skills, .claude/skills and other known locations.';
  $('#save-registration').textContent = agent ? 'Save folder' : isAgent ? 'Add agent' : 'Add workspace';
  $('#registration-error').textContent = '';
  $('#registration').hidden = false;
  $('#registration-form').elements[isAgent ? 'name' : 'path'].focus();
}
function share() {
  if (!detail) return;
  $('#share-name').textContent = detail.name;
  $('#share-error').textContent = '';
  $('#share-results').innerHTML = '';
  $('#share-form').reset();
  $('#sync-submit').innerHTML = `${icon('link')}Create links`;
  renderShareTargets();
  $('#share-dialog').showModal();
}
function renderShareTargets() {
  const copy = $('#share-form').elements.mode.value === 'copy';
  const selectedIds = new Set([...$('#share-targets').querySelectorAll('input:checked')].map((input) => input.value));
  $('#share-targets').innerHTML = state.agents.map((agent) => {
    const already = detail.locations.some((entry) => entry.ownerId === agent.id && entry.scope === 'system');
    const destination = agent.path ? `${shortPath(agent.path)}/${detail.folder}` : 'Configure this agent in the Agents tab first.';
    return `<label class="destination"><input type="checkbox" name="target" value="${escapeHTML(agent.id)}" ${!agent.path || already ? 'disabled' : ''} ${selectedIds.has(agent.id) && agent.path && !already ? 'checked' : ''}><span><strong>${escapeHTML(agent.name)}</strong><code class="path">${escapeHTML(destination)}</code></span>${already ? '<span class="status">Has source</span>' : !agent.path ? '<span class="status">Needs folder</span>' : ''}</label>`;
  }).join('');
  $('#sync-submit').innerHTML = `${icon(copy ? 'file' : 'link')}${copy ? 'Create copies' : 'Create links'}`;
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button, a[data-tab], a[data-help]');
  if (!button) return;
  try {
    if (button.dataset.tab) { event.preventDefault(); setTab(button.dataset.tab); }
    if (button.dataset.help) { event.preventDefault(); openHelp(button.dataset.help); }
    if (button.dataset.skill) {
      if (editing && !confirm('Discard unsaved skill edits?')) return;
      setEditing(false);
      selected = button.dataset.skill;
      detailTab = 'instructions';
      renderLibrary();
      if (matchMedia('(max-width: 800px)').matches) $('#inspector').scrollIntoView({ block: 'start' });
    }
    if (button.dataset.detailTab) {
      if (editing && !confirm('Discard unsaved skill edits?')) return;
      setEditing(false);
      detailTab = button.dataset.detailTab;
      renderDetail();
    }
    if (button.dataset.configure) openRegistration('agent', state.agents.find((agent) => agent.id === button.dataset.configure));
    if (button.dataset.removeWorkspace || button.dataset.removeAgent) {
      if (!confirm('Remove this registration? No skill files or existing links will be deleted.')) return;
      await busy(button, async () => {
        const result = await api('/api/remove', { kind: button.dataset.removeWorkspace ? 'workspaces' : 'agents', id: button.dataset.removeWorkspace || button.dataset.removeAgent });
        await refresh(); notify(result.message);
      });
    }
    if (button.dataset.unlink) {
      if (!confirm('Disconnect this agent’s link? Its access through this link ends; the source stays untouched.')) return;
      await busy(button, async () => { const result = await api('/api/unlink', { id: button.dataset.unlink }); await refresh(); notify(result.message); });
    }
    if (button.dataset.restore) {
      await busy(button, async () => {
        const result = await api('/api/restore-skill', { id: button.dataset.restore });
        await refresh(); notify(result.message);
      });
    }
    if (button.dataset.addDiscovered) {
      await busy(button, async () => {
        await api('/api/workspaces', { path: button.dataset.addDiscovered });
        await refresh();
        button.textContent = 'Registered';
        notify('Workspace registered. Its skills are now in your library.');
      });
      button.disabled = true;
    }
    switch (button.dataset.action) {
      case 'share': share(); break;
      case 'remove-skill':
        if (editing && !confirm('Discard unsaved skill edits before removing this location?')) break;
        setEditing(false);
        renderDetail();
        openRemoval();
        break;
      case 'library': setTab('library'); break;
      case 'add-workspace': openRegistration('workspace'); break;
      case 'clear-filters': $('#search').value = ''; $('#scope').value = ''; $('#source').value = ''; currentPage = 1; renderLibrary(); break;
      case 'retry-detail': loadDetail(selected); break;
      case 'edit':
        setEditing(true);
        $('#detail-content').innerHTML = '<label class="detail-label" for="skill-editor">Edit source SKILL.md (changes affect all links)</label><textarea id="skill-editor" class="editor" spellcheck="false"></textarea><p class="form-error" id="editor-error" role="alert"></p><div class="edit-actions"><button class="button quiet" data-action="cancel-edit">Cancel</button><button class="button primary" data-action="save-edit">Save source</button></div>';
        $('#skill-editor').value = detail.document;
        $('#skill-editor').focus();
        break;
      case 'cancel-edit': if (confirm('Discard these edits?')) { setEditing(false); renderDetail(); } break;
      case 'save-edit':
        if (!confirm('Save the source SKILL.md? Every agent linked to this skill will use the changed instructions.')) break;
        await busy(button, async () => {
          try {
            const result = await api('/api/edit', { skillId: detail.id, document: $('#skill-editor').value, version: detail.version });
            setEditing(false);
            await refresh();
            notify(result.message);
          } catch (error) { $('#editor-error').textContent = error.message; }
        });
        break;
    }
  } catch (error) { notify(error.message, true); }
});

$('#refresh').addEventListener('click', async () => {
  if (editing && !confirm('Discard unsaved skill edits and rescan?')) return;
  setEditing(false);
  try { await busy($('#refresh'), refresh); notify('Inventory refreshed from your local folders.'); }
  catch (error) { notify(error.message, true); }
});
$('#add-source').addEventListener('click', () => {
  if (tab === 'help') setTab('library');
  else if (tab === 'activity') { setTab('library'); if (detail) share(); }
  else openRegistration(tab === 'agents' ? 'agent' : 'workspace');
});
$('#cancel-registration').addEventListener('click', () => { $('#registration').hidden = true; });
$('#registration-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#registration-error').textContent = '';
  const form = event.currentTarget;
  try {
    await busy($('#save-registration'), async () => {
      await api(registrationKind === 'agent' ? '/api/agents' : '/api/workspaces', { name: form.elements.name.value, path: form.elements.path.value, ...(editingAgent ? { id: editingAgent } : {}) });
      $('#registration').hidden = true;
      await refresh();
      notify(registrationKind === 'agent' ? 'Agent folder saved. No files were moved or created.' : 'Workspace registered. Its skills are ready to reuse.');
    });
  } catch (error) { $('#registration-error').textContent = error.message; }
});
for (const selector of ['#search', '#scope', '#source']) {
  $(selector).addEventListener(selector === '#search' ? 'input' : 'change', () => {
    if (editing) { notify('Save or cancel your skill edit before changing filters.', true); return; }
    currentPage = 1; renderLibrary();
  });
}
$('#previous-page').addEventListener('click', () => { currentPage--; renderLibrary(); });
$('#next-page').addEventListener('click', () => { currentPage++; renderLibrary(); });
$('#discover').addEventListener('click', async () => {
  $('#discovery-results').textContent = 'Checking common project folders…';
  try {
    await busy($('#discover'), async () => {
      const result = await api('/api/discover');
      $('#discovery-results').innerHTML = (result.candidates.length ? result.candidates.map((candidate) => `<div class="discovery-row"><div><strong>${escapeHTML(candidate.name)}</strong><code class="path">${escapeHTML(shortPath(candidate.path))}</code></div><button class="button quiet" data-add-discovered="${escapeHTML(candidate.path)}">Register</button></div>`).join('') : '<p class="muted">No unregistered workspaces found in common folders. Add a path above to look elsewhere.</p>') + result.warnings.map((warning) => `<p class="form-error">${escapeHTML(warning)}</p>`).join('');
    });
  } catch (error) { $('#discovery-results').textContent = `Discovery failed: ${error.message}`; }
});
for (const selector of ['#close-share', '#cancel-share']) $(selector).addEventListener('click', () => $('#share-dialog').close());
for (const selector of ['#close-remove', '#cancel-remove']) $(selector).addEventListener('click', () => $('#remove-dialog').close());
$('#remove-location').addEventListener('change', removalImpact);
$('#remove-help').addEventListener('click', (event) => { event.preventDefault(); $('#remove-dialog').close(); openHelp('removal'); });
$('#remove-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#remove-error').textContent = '';
  try {
    await busy($('#remove-submit'), async () => {
      const result = await api('/api/remove-skill', {
        skillId: removalDetail.id, version: removalDetail.version,
        location: $('#remove-location').value, confirmation: $('#remove-confirmation').value,
      });
      $('#remove-dialog').close();
      await refresh();
      notify(result.message);
    });
  } catch (error) { $('#remove-error').textContent = error.message; }
});
$('#share-dialog').addEventListener('click', (event) => { if (event.target === $('#share-dialog') && event.offsetX < 0) $('#share-dialog').close(); });
$('#share-form').addEventListener('change', (event) => { if (event.target.name === 'mode') renderShareTargets(); });
$('#select-all').addEventListener('click', () => $('#share-targets').querySelectorAll('input:not(:disabled)').forEach((input) => { input.checked = true; }));
$('#clear-targets').addEventListener('click', () => $('#share-targets').querySelectorAll('input').forEach((input) => { input.checked = false; }));
$('#share-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#share-error').textContent = '';
  const form = event.currentTarget;
  const targets = [...form.querySelectorAll('input[name="target"]:checked')].map((input) => input.value);
  if (!targets.length) { $('#share-error').textContent = 'Choose at least one configured agent destination.'; return; }
  try {
    await busy($('#sync-submit'), async () => {
      const result = await api('/api/sync', { skillId: detail.id, mode: form.elements.mode.value, targets });
      $('#share-results').innerHTML = result.results.map((entry) => `<p class="sync-result ${escapeHTML(entry.status)}"><strong>${escapeHTML(entry.agent)}: ${escapeHTML(entry.status)}</strong>${escapeHTML(entry.message)}</p>`).join('');
      const failed = result.results.filter((entry) => ['error', 'conflict'].includes(entry.status)).length;
      await refresh();
      await loadDetail(selected);
      renderShareTargets();
      notify(failed ? `${failed} destination(s) could not be shared. See the per-agent results.` : 'Skill shared. Access remains available after you close this dashboard.', !!failed);
    });
  } catch (error) { $('#share-error').textContent = error.message; }
});
window.addEventListener('beforeunload', (event) => { if (editing) event.preventDefault(); });
$('#search').value = initial.get('q') || '';
$('#scope').value = initial.get('scope') || '';
setTab(tab);
if (tab === 'help' && location.hash) openHelp(location.hash.slice(1));
refresh().catch((error) => {
  notify(`Could not load the inventory: ${error.message} Use Rescan to retry.`, true);
  $('#scan-time').textContent = 'Inventory unavailable';
  $('#skills-body').innerHTML = '<tr><td colspan="4"><div class="empty-state"><h3>Could not read local skills.</h3><p>Check the error above, then use Rescan.</p></div></td></tr>';
});
