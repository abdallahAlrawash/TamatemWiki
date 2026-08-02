const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const STORAGE_KEY = 'superstar-brain-v1';

const SECTIONS = [
  {
    id: 'game-knowledge',
    label: 'Game Knowledge',
    icon: '<svg viewBox="0 0 16 16"><path d="M1.5 3.2c2-.9 4.1-.9 6 .6 1.9-1.5 4-1.5 6-.6v9.2c-2-.9-4.1-.9-6 .6-1.9-1.5-4-1.5-6-.6zM7.5 3.8v9.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
  {
    id: 'audience-personas',
    label: 'Audience Personas',
    icon: '<svg viewBox="0 0 16 16"><circle cx="5.4" cy="5.6" r="2.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M1.6 13c0-2.6 7.6-2.6 7.6 0M11 7.9a1.9 1.9 0 1 0-.2-3.8M10.7 10.4c2-.3 3.9.6 3.9 2.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  },
  {
    id: 'game-assets',
    label: 'Game Assets',
    icon: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="5.6" cy="6.4" r="1.1" fill="currentColor"/><path d="M2.4 11.2 5.8 8.4l2.8 2.3 2.3-1.9 2.7 2.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
  {
    id: 'performance-learnings',
    label: 'Performance Learnings',
    icon: '<svg viewBox="0 0 16 16"><path d="M3.2 13V8.6M7 13V3.6M10.8 13V6.4M2 13.6h12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  },
  {
    id: 'production-rules',
    label: 'Production Rules',
    icon: '<svg viewBox="0 0 16 16"><path d="M2 4.4h12M2 8h12M2 11.6h12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="5.2" cy="4.4" r="1.5" fill="#fff" stroke="currentColor" stroke-width="1.4"/><circle cx="10.4" cy="8" r="1.5" fill="#fff" stroke="currentColor" stroke-width="1.4"/><circle cx="6.6" cy="11.6" r="1.5" fill="#fff" stroke="currentColor" stroke-width="1.4"/></svg>',
  },
];

const GHOST_LAYOUT = [
  { angleOffset: -24, distance: 138, width: 112 },
  { angleOffset: 26, distance: 168, width: 88 },
];

const GROUP_DISTANCE = 156;
const THOUGHT_DISTANCE = 104;

const NODE_RADIUS = {
  core: 64,
  section: 62,
  group: 72,
  thought: 52,
};

const state = {
  nodes: new Map(),
  ghosts: [],
  selectedId: null,
  counter: 0,
  initialized: false,
  restoring: false,
};

const edgeRegistry = new Map();

const addStub = {
  el: null,
  labelEl: null,
  parentId: null,
  visible: false,
  x: 0,
  y: 0,
  hideTimer: null,
};

const deletePopover = {
  el: null,
  messageEl: null,
  targetId: null,
};

let canvas = null;
let edgesSvg = null;
let composer = null;
let composerInput = null;
let composerChips = null;
let attachButton = null;
let sendButton = null;
let fileInput = null;
let dotCanvas = null;
let dotCtx = null;
let saveTimer = null;
let pendingFiles = [];

const dotField = {
  spacing: 24,
  influenceRadius: 132,
  cols: 0,
  rows: 0,
  offsetX: 0,
  offsetY: 0,
  width: 0,
  height: 0,
  level: null,
  mouseX: -9999,
  mouseY: -9999,
  active: false,
  running: false,
};

function nextId(prefix) {
  state.counter += 1;
  return `${prefix}-${state.counter}`;
}

function truncateLabel(text, maxLength = 24) {
  const clean = text.replace(/\s+/g, ' ').trim();

  if (clean.length <= maxLength) {
    return clean;
  }

  return `${clean.slice(0, maxLength - 1).trimEnd()}…`;
}

function canvasSize() {
  const rect = canvas.getBoundingClientRect();

  return { width: rect.width, height: rect.height };
}

function clampToCanvas(x, y) {
  const { width, height } = canvasSize();

  return {
    x: Math.min(Math.max(x, 24), width - 24),
    y: Math.min(Math.max(y, 24), height - 24),
  };
}

function childrenOf(nodeId) {
  return [...state.nodes.values()].filter((node) => node.parentId === nodeId);
}

function addableChildCount(parent) {
  if (parent.type === 'section') {
    return childrenOf(parent.id).filter((node) => node.type === 'group').length;
  }

  return childrenOf(parent.id).length;
}

function positionNode(node) {
  node.el.style.left = `${node.x}px`;
  node.el.style.top = `${node.y}px`;
}

function edgePath(fromNode, toPoint) {
  const deltaX = toPoint.x - fromNode.x;
  const deltaY = toPoint.y - fromNode.y;
  const midX = fromNode.x + deltaX / 2 - deltaY * 0.08;
  const midY = fromNode.y + deltaY / 2 + deltaX * 0.08;

  return `M ${fromNode.x} ${fromNode.y} Q ${midX} ${midY} ${toPoint.x} ${toPoint.y}`;
}

function upsertEdge(key, pathData, className, { withPulse = false, length = 0 } = {}) {
  let entry = edgeRegistry.get(key);

  if (!entry) {
    const path = document.createElementNS(SVG_NS, 'path');

    path.setAttribute('id', `brain-edge-${key}`);
    edgesSvg.append(path);

    let pulse = null;

    if (withPulse) {
      const duration = Math.min(3.4, Math.max(1.5, length / 64));

      pulse = document.createElementNS(SVG_NS, 'circle');
      pulse.setAttribute('class', 'brain-pulse');
      pulse.setAttribute('r', '2.4');

      const motion = document.createElementNS(SVG_NS, 'animateMotion');

      motion.setAttribute('dur', `${duration.toFixed(2)}s`);
      motion.setAttribute('repeatCount', 'indefinite');
      motion.setAttribute('begin', `${(-(((Math.sin(length) + 1) / 2) * duration)).toFixed(2)}s`);

      const mpath = document.createElementNS(SVG_NS, 'mpath');

      mpath.setAttribute('href', `#brain-edge-${key}`);
      mpath.setAttributeNS(XLINK_NS, 'xlink:href', `#brain-edge-${key}`);
      motion.append(mpath);
      pulse.append(motion);
      edgesSvg.append(pulse);
    }

    entry = { path, pulse };
    edgeRegistry.set(key, entry);
  }

  entry.path.setAttribute('d', pathData);
  entry.path.setAttribute('class', className);
}

function redrawEdges() {
  const { width, height } = canvasSize();

  edgesSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const liveKeys = new Set();

  state.ghosts.forEach((ghost, index) => {
    const section = state.nodes.get(ghost.sectionId);

    if (!section || ghost.removed) {
      return;
    }

    const key = `ghost-${index}`;

    liveKeys.add(key);
    upsertEdge(
      key,
      edgePath(section, { x: section.x + ghost.dx, y: section.y + ghost.dy }),
      'brain-edge brain-edge-ghost',
    );
  });

  for (const node of state.nodes.values()) {
    if (!node.parentId) {
      continue;
    }

    const parent = state.nodes.get(node.parentId);

    if (!parent) {
      continue;
    }

    const key = `node-${node.id}`;

    liveKeys.add(key);
    upsertEdge(key, edgePath(parent, node), 'brain-edge', {
      withPulse: true,
      length: Math.hypot(node.x - parent.x, node.y - parent.y),
    });
  }

  if (addStub.visible && addStub.parentId) {
    const parent = state.nodes.get(addStub.parentId);

    if (parent) {
      liveKeys.add('stub');
      upsertEdge('stub', edgePath(parent, addStub), 'brain-edge brain-edge-stub');
    }
  }

  for (const [key, entry] of edgeRegistry) {
    if (!liveKeys.has(key)) {
      entry.path.remove();
      entry.pulse?.remove();
      edgeRegistry.delete(key);
    }
  }
}

function positionGhosts() {
  for (const ghost of state.ghosts) {
    const section = state.nodes.get(ghost.sectionId);

    if (!section || ghost.removed) {
      continue;
    }

    ghost.el.style.left = `${section.x + ghost.dx}px`;
    ghost.el.style.top = `${section.y + ghost.dy}px`;
  }
}

function centerBrainInCanvas() {
  const core = state.nodes.get('core');

  if (!core) {
    return;
  }

  const { width, height } = canvasSize();
  const deltaX = (width / 2) - core.x;
  const deltaY = (height / 2) - core.y;

  if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) {
    return;
  }

  for (const node of state.nodes.values()) {
    node.x += deltaX;
    node.y += deltaY;
    positionNode(node);
  }

  if (addStub.visible) {
    addStub.x += deltaX;
    addStub.y += deltaY;
    addStub.el.style.left = `${addStub.x}px`;
    addStub.el.style.top = `${addStub.y}px`;
  }

  positionGhosts();
}

function removeSectionGhosts(sectionId) {
  for (const ghost of state.ghosts) {
    if (ghost.sectionId === sectionId && !ghost.removed) {
      ghost.removed = true;
      ghost.el.classList.add('is-fading');
      setTimeout(() => ghost.el.remove(), 360);
    }
  }

  redrawEdges();
}

function pruneGhostsForPopulatedSections() {
  for (const node of state.nodes.values()) {
    if (node.type !== 'section') {
      continue;
    }

    const hasGroup = childrenOf(node.id).some((child) => child.type === 'group');

    if (!hasGroup) {
      continue;
    }

    for (const ghost of state.ghosts) {
      if (ghost.sectionId === node.id && !ghost.removed) {
        ghost.removed = true;
        ghost.el.remove();
      }
    }
  }
}

function spawnSectionGhosts(section) {
  const center = state.nodes.get('core');
  const outwardAngle = Math.atan2(section.y - center.y, section.x - center.x);

  for (const ghostSpec of GHOST_LAYOUT) {
    const ghostAngle = outwardAngle + (ghostSpec.angleOffset * Math.PI) / 180;
    const ghost = {
      sectionId: section.id,
      dx: Math.cos(ghostAngle) * ghostSpec.distance,
      dy: Math.sin(ghostAngle) * ghostSpec.distance,
      width: ghostSpec.width,
      removed: false,
    };

    const ghostEl = document.createElement('span');

    ghostEl.className = 'brain-ghost';
    ghostEl.style.width = `${ghostSpec.width}px`;
    ghost.el = ghostEl;
    canvas.append(ghostEl);
    state.ghosts.push(ghost);
  }
}

function restoreSectionGhosts(section) {
  const hasActive = state.ghosts.some((ghost) => ghost.sectionId === section.id && !ghost.removed);

  if (hasActive) {
    return;
  }

  state.ghosts = state.ghosts.filter((ghost) => ghost.sectionId !== section.id);
  spawnSectionGhosts(section);
  positionGhosts();
}

function deleteNode(node) {
  if (node.type !== 'group' && node.type !== 'thought') {
    return;
  }

  const section = node.type === 'group' ? state.nodes.get(node.parentId) : null;
  const targets = node.type === 'group' ? [node, ...childrenOf(node.id)] : [node];

  for (const target of targets) {
    if (state.selectedId === target.id) {
      clearSelection();
    }

    target.el.remove();
    state.nodes.delete(target.id);
  }

  if (section && !childrenOf(section.id).some((child) => child.type === 'group')) {
    restoreSectionGhosts(section);
  }

  redrawEdges();
  scheduleSave();
}

function addDeleteButton(node) {
  const button = document.createElement('button');

  button.type = 'button';
  button.className = 'brain-delete';
  button.setAttribute('aria-label', node.type === 'group' ? 'Delete group' : 'Delete thought');
  button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.4 4.5V3.2h3.2v1.3M4.9 4.5l.6 8.3h5l.6-8.3M6.8 6.6v4.2M9.2 6.6v4.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  button.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
  });
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    showDeleteConfirm(node);
  });
  node.el.append(button);
}

function createDeletePopover() {
  const el = document.createElement('div');
  const message = document.createElement('p');
  const actions = document.createElement('div');
  const cancelButton = document.createElement('button');
  const confirmButton = document.createElement('button');

  el.className = 'brain-confirm';
  el.hidden = true;
  message.className = 'brain-confirm-message';
  actions.className = 'brain-confirm-actions';
  cancelButton.type = 'button';
  cancelButton.className = 'brain-confirm-cancel';
  cancelButton.textContent = 'Cancel';
  confirmButton.type = 'button';
  confirmButton.className = 'brain-confirm-delete';
  confirmButton.textContent = 'Delete';
  actions.append(cancelButton, confirmButton);
  el.append(message, actions);
  canvas.append(el);

  el.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
  });
  cancelButton.addEventListener('click', hideDeleteConfirm);
  confirmButton.addEventListener('click', () => {
    const node = deletePopover.targetId ? state.nodes.get(deletePopover.targetId) : null;

    hideDeleteConfirm();

    if (node) {
      deleteNode(node);
    }
  });

  deletePopover.el = el;
  deletePopover.messageEl = message;
}

function showDeleteConfirm(node) {
  deletePopover.targetId = node.id;
  deletePopover.messageEl.textContent = node.type === 'group'
    ? 'Delete this group and its thoughts?'
    : 'Delete this thought?';
  deletePopover.el.hidden = false;
  deletePopover.el.style.left = `${node.x}px`;
  deletePopover.el.style.top = `${Math.max(node.y - 54, 12)}px`;
}

function hideDeleteConfirm() {
  if (!deletePopover.el || deletePopover.el.hidden) {
    return;
  }

  deletePopover.targetId = null;
  deletePopover.el.hidden = true;
}

function fanOffsetAngle(index) {
  if (index === 0) {
    return 0;
  }

  const step = Math.ceil(index / 2) * 28;

  return index % 2 === 1 ? step : -step;
}

function childPlacement(parent, grandparent, index, distance) {
  const baseAngle = grandparent
    ? Math.atan2(parent.y - grandparent.y, parent.x - grandparent.x)
    : Math.atan2(parent.y - canvasSize().height / 2, parent.x - canvasSize().width / 2);
  const angle = baseAngle + (fanOffsetAngle(index) * Math.PI) / 180;

  return clampToCanvas(
    parent.x + Math.cos(angle) * distance,
    parent.y + Math.sin(angle) * distance,
  );
}

function isFreePlacement(point, childType, parentId) {
  for (const node of state.nodes.values()) {
    if (node.id === parentId) {
      continue;
    }

    const minDistance = NODE_RADIUS[childType] + NODE_RADIUS[node.type];

    if (Math.hypot(node.x - point.x, node.y - point.y) < minDistance) {
      return false;
    }
  }

  for (const ghost of state.ghosts) {
    const section = state.nodes.get(ghost.sectionId);

    if (!section || ghost.removed) {
      continue;
    }

    const ghostX = section.x + ghost.dx;
    const ghostY = section.y + ghost.dy;
    const ghostRadius = ghost.width / 2 + 22;

    if (Math.hypot(ghostX - point.x, ghostY - point.y) < NODE_RADIUS[childType] + ghostRadius) {
      return false;
    }
  }

  return true;
}

function findFreePlacement(parent) {
  const grandparent = parent.type === 'section'
    ? state.nodes.get('core')
    : state.nodes.get(parent.parentId);
  const childType = parent.type === 'section' ? 'group' : 'thought';
  const baseDistance = parent.type === 'section' ? GROUP_DISTANCE : THOUGHT_DISTANCE;
  const startIndex = addableChildCount(parent);

  for (const distanceScale of [1, 1.4, 1.85]) {
    for (let slot = 0; slot < 13; slot += 1) {
      const point = childPlacement(
        parent,
        grandparent,
        startIndex + slot,
        baseDistance * distanceScale,
      );

      if (isFreePlacement(point, childType, parent.id)) {
        return point;
      }
    }
  }

  return childPlacement(parent, grandparent, startIndex, baseDistance);
}

function animateNodesTo(targets, duration = 340) {
  const startPositions = new Map(
    [...targets.keys()].map((id) => {
      const node = state.nodes.get(id);

      return [id, { x: node.x, y: node.y }];
    }),
  );
  const startTime = performance.now();
  const ease = (t) => 1 - (1 - t) ** 3;

  const step = (now) => {
    const progress = Math.min(1, (now - startTime) / duration);
    const eased = ease(progress);

    for (const [id, target] of targets) {
      const node = state.nodes.get(id);
      const start = startPositions.get(id);

      if (!node) {
        continue;
      }

      node.x = start.x + (target.x - start.x) * eased;
      node.y = start.y + (target.y - start.y) * eased;
      positionNode(node);
    }

    positionGhosts();
    redrawEdges();

    if (progress < 1) {
      requestAnimationFrame(step);
    }
  };

  requestAnimationFrame(step);
}

function settleAround(newNode) {
  const positions = new Map(
    [...state.nodes.values()].map((node) => [node.id, { x: node.x, y: node.y }]),
  );
  const fixedIds = new Set(['core', newNode.id]);
  const ids = [...state.nodes.keys()];

  for (let iteration = 0; iteration < 4; iteration += 1) {
    let movedAny = false;

    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const nodeA = state.nodes.get(ids[i]);
        const nodeB = state.nodes.get(ids[j]);
        const positionA = positions.get(nodeA.id);
        const positionB = positions.get(nodeB.id);
        const aFixed = fixedIds.has(nodeA.id);
        const bFixed = fixedIds.has(nodeB.id);

        if (aFixed && bFixed) {
          continue;
        }

        const minDistance = NODE_RADIUS[nodeA.type] + NODE_RADIUS[nodeB.type];
        let deltaX = positionB.x - positionA.x;
        let deltaY = positionB.y - positionA.y;
        let distance = Math.hypot(deltaX, deltaY);

        if (distance >= minDistance) {
          continue;
        }

        if (distance < 1) {
          deltaX = 1;
          deltaY = 0;
          distance = 1;
        }

        const overlap = minDistance - distance + 4;
        const unitX = deltaX / distance;
        const unitY = deltaY / distance;
        const aShare = aFixed ? 0 : bFixed ? 1 : 0.5;
        const bShare = bFixed ? 0 : aFixed ? 1 : 0.5;

        if (aShare) {
          const next = clampToCanvas(
            positionA.x - unitX * overlap * aShare,
            positionA.y - unitY * overlap * aShare,
          );

          positionA.x = next.x;
          positionA.y = next.y;
        }

        if (bShare) {
          const next = clampToCanvas(
            positionB.x + unitX * overlap * bShare,
            positionB.y + unitY * overlap * bShare,
          );

          positionB.x = next.x;
          positionB.y = next.y;
        }

        movedAny = true;
      }
    }

    if (!movedAny) {
      break;
    }
  }

  const targets = new Map();

  for (const [id, position] of positions) {
    const node = state.nodes.get(id);

    if (node && Math.hypot(position.x - node.x, position.y - node.y) > 0.5) {
      targets.set(id, position);
    }
  }

  if (targets.size) {
    animateNodesTo(targets);
  }
}

function showAddStub(parent) {
  if (parent.el.classList.contains('is-dragging')) {
    return;
  }

  clearTimeout(addStub.hideTimer);
  addStub.hideTimer = null;

  const placement = findFreePlacement(parent);

  addStub.parentId = parent.id;
  addStub.x = placement.x;
  addStub.y = placement.y;
  addStub.visible = true;
  addStub.labelEl.textContent = parent.type === 'section' ? 'Add group' : 'Add memory';
  addStub.el.hidden = false;
  addStub.el.style.left = `${placement.x}px`;
  addStub.el.style.top = `${placement.y}px`;
  redrawEdges();
}

function hideAddStub() {
  clearTimeout(addStub.hideTimer);
  addStub.hideTimer = null;

  if (!addStub.visible) {
    return;
  }

  addStub.visible = false;
  addStub.parentId = null;
  addStub.el.hidden = true;
  redrawEdges();
}

function scheduleHideAddStub() {
  clearTimeout(addStub.hideTimer);
  addStub.hideTimer = setTimeout(hideAddStub, 240);
}

function flashComposerHint(message) {
  composerInput.placeholder = message;
  composer.classList.remove('is-shaking');
  void composer.offsetWidth;
  composer.classList.add('is-shaking');
  setTimeout(() => {
    if (!state.selectedId) {
      composerInput.placeholder = 'Add a memory';
    }
  }, 2200);
}

function renderChips() {
  const node = state.selectedId ? state.nodes.get(state.selectedId) : null;
  const entries = [];

  if (node && node.type === 'thought') {
    node.files.forEach((file, index) => {
      entries.push({
        name: file.name,
        pending: !file.path,
        remove: () => {
          node.files.splice(index, 1);
          updateThoughtLabel(node);
          scheduleSave();
          renderChips();
        },
      });
    });
  } else if (!node) {
    pendingFiles.forEach((file, index) => {
      entries.push({
        name: file.name,
        pending: true,
        remove: () => {
          pendingFiles.splice(index, 1);
          renderChips();
        },
      });
    });
  }

  composerChips.replaceChildren();
  composerChips.hidden = entries.length === 0;

  for (const entry of entries) {
    const chip = document.createElement('span');
    const name = document.createElement('span');
    const removeButton = document.createElement('button');

    chip.className = 'brain-chip';
    chip.classList.toggle('is-pending', entry.pending);
    name.textContent = entry.name;
    removeButton.type = 'button';
    removeButton.className = 'brain-chip-remove';
    removeButton.setAttribute('aria-label', `Remove ${entry.name}`);
    removeButton.textContent = '×';
    removeButton.addEventListener('click', entry.remove);
    chip.append(name, removeButton);
    composerChips.append(chip);
  }
}

function updateThoughtLabel(thought) {
  const label = thought.el.querySelector('.brain-thought-label');
  const fallback = thought.files?.length ? thought.files[0].name : '';
  const text = thought.content || fallback;

  label.textContent = text ? truncateLabel(text) : 'New thought';
  label.classList.toggle('is-empty', !text);
}

function applySelectionHighlight(id) {
  for (const node of state.nodes.values()) {
    if (node.type === 'thought' || node.type === 'group') {
      node.el.classList.toggle('is-selected', node.id === id);
    }
  }
}

function selectNode(id) {
  const node = state.nodes.get(id);

  if (!node || (node.type !== 'thought' && node.type !== 'group')) {
    return;
  }

  state.selectedId = id;
  pendingFiles = [];
  applySelectionHighlight(id);

  if (node.type === 'thought') {
    composerInput.value = node.content || '';
    composerInput.placeholder = 'Describe this memory…';
    attachButton.hidden = false;
    renderChips();
  } else {
    composerInput.value = node.description || '';
    composerInput.placeholder = 'Describe this group…';
    attachButton.hidden = true;
    composerChips.hidden = true;
    composerChips.replaceChildren();
  }

  composerInput.focus();
}

function clearSelection() {
  if (!state.selectedId) {
    return;
  }

  state.selectedId = null;
  applySelectionHighlight(null);
  composerInput.value = '';
  composerInput.placeholder = 'Add a memory';
  attachButton.hidden = false;
  composerChips.hidden = true;
  composerChips.replaceChildren();
}

async function requestCapture(text) {
  const payload = JSON.stringify({ text, brain: serializeBrain() });
  let lastError = new Error('Could not reach capture.');

  for (const url of ['/api/brain/capture', 'http://127.0.0.1:8787/api/brain/capture']) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        return data;
      }

      lastError = new Error(data.error || 'Capture failed.');
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

function glowNewNode(node) {
  if (!node?.el) {
    return;
  }

  node.el.classList.remove('is-captured');
  void node.el.offsetWidth;
  node.el.classList.add('is-captured');
  setTimeout(() => node.el.classList.remove('is-captured'), 1700);
}

function applyCapture(routing, text) {
  let group = routing.targetGroupId ? state.nodes.get(routing.targetGroupId) : null;

  if (!group || group.type !== 'group') {
    const section = state.nodes.get(routing.sectionId);

    if (!section) {
      return null;
    }

    group = createGroup(section, null, null, { silent: true, title: routing.newGroupTitle });
  }

  return createThought(group, null, null, { content: text, silent: true });
}

function setComposerCapturing(isCapturing) {
  composerInput.disabled = isCapturing;
  sendButton.disabled = isCapturing;
  attachButton.disabled = isCapturing;
  composer.classList.toggle('is-capturing', isCapturing);
  composerInput.placeholder = isCapturing ? 'Filing your thought…' : 'Add a memory';
}

function showCaptureToast({ sectionTitle, groupLabel, error }) {
  const root = document.querySelector('#brain-window');

  if (!root) {
    return;
  }

  const toast = document.createElement('div');

  toast.className = 'brain-toast';
  toast.classList.toggle('is-error', Boolean(error));
  toast.textContent = error
    ? `Couldn't file that: ${error}`
    : `Filed under ${[sectionTitle, groupLabel].filter(Boolean).join('  ›  ')}`;
  root.append(toast);

  setTimeout(() => {
    toast.classList.add('is-leaving');
    setTimeout(() => toast.remove(), 300);
  }, 2800);
}

async function captureThought(text) {
  const staged = [...pendingFiles];

  setComposerCapturing(true);

  try {
    const routing = await requestCapture(text);
    const node = applyCapture(routing, text);

    composerInput.value = '';
    pendingFiles = [];

    if (node) {
      glowNewNode(node);

      for (const file of staged) {
        const entry = { name: file.name, size: file.size, path: '' };

        node.files.push(entry);

        try {
          const dataBase64 = await readFileBase64(file);
          const stored = await uploadBrainFile(node.id, file.name, dataBase64);

          if (stored?.path) {
            entry.path = stored.path;
          }
        } catch {
          // keep the reference even if the upload failed
        }
      }

      if (staged.length) {
        updateThoughtLabel(node);
        scheduleSave();
      }
    }

    const group = node
      ? state.nodes.get(node.type === 'thought' ? node.parentId : node.id)
      : null;

    showCaptureToast({
      sectionTitle: routing.sectionTitle,
      groupLabel: group?.type === 'group' ? group.label : '',
    });
  } catch (error) {
    showCaptureToast({ error: error.message });
  } finally {
    setComposerCapturing(false);
    renderChips();
  }
}

function saveSelected() {
  const node = state.selectedId ? state.nodes.get(state.selectedId) : null;

  if (!node) {
    const text = composerInput.value.trim();

    if (!text) {
      flashComposerHint('Type a memory, or click a thought to edit…');
      return;
    }

    void captureThought(text);
    return;
  }

  const value = composerInput.value.trim();

  if (node.type === 'thought') {
    node.content = value;
    updateThoughtLabel(node);
  } else {
    node.description = value;
    node.el.title = value;
    node.el.classList.toggle('has-description', Boolean(value));
  }

  node.el.classList.remove('is-saved');
  void node.el.offsetWidth;
  node.el.classList.add('is-saved');
  scheduleSave();
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function uploadBrainFile(thoughtId, name, dataBase64) {
  for (const url of ['/api/brain/upload', 'http://127.0.0.1:8787/api/brain/upload']) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thoughtId, name, dataBase64 }),
      });

      if (response.ok) {
        return response.json();
      }
    } catch {
      // try next url
    }
  }

  return null;
}

async function attachFiles(fileList) {
  const node = state.selectedId ? state.nodes.get(state.selectedId) : null;

  if (node && node.type === 'group') {
    flashComposerHint('Pick a thought to attach files…');
    return;
  }

  if (!node) {
    for (const file of fileList) {
      pendingFiles.push(file);
    }

    renderChips();
    return;
  }

  for (const file of fileList) {
    const entry = { name: file.name, size: file.size, path: '' };

    node.files.push(entry);
    renderChips();
    updateThoughtLabel(node);

    try {
      const dataBase64 = await readFileBase64(file);
      const stored = await uploadBrainFile(node.id, file.name, dataBase64);

      if (stored?.path) {
        entry.path = stored.path;
      }
    } catch {
      // keep the reference even if the upload failed
    }

    renderChips();
    scheduleSave();
  }
}

function startTitleEdit(group, onCommit) {
  const label = group.el.querySelector('.brain-group-label');

  label.setAttribute('contenteditable', 'plaintext-only');

  if (!label.isContentEditable) {
    label.setAttribute('contenteditable', 'true');
  }

  label.focus();

  const range = document.createRange();

  range.selectNodeContents(label);

  const selection = window.getSelection();

  selection.removeAllRanges();
  selection.addRange(range);

  const commit = () => {
    label.removeAttribute('contenteditable');
    group.label = label.textContent.trim() || 'Untitled';
    label.textContent = group.label;
    label.removeEventListener('blur', commit);
    label.removeEventListener('keydown', onKeydown);
    scheduleSave();
    onCommit?.();
  };

  const onKeydown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      label.blur();
    }

    if (event.key === 'Escape') {
      label.textContent = group.label;
      label.blur();
    }
  };

  label.addEventListener('blur', commit);
  label.addEventListener('keydown', onKeydown);
}

function findDropGroup(point, excludeId) {
  for (const node of state.nodes.values()) {
    if (node.type !== 'group' || node.id === excludeId) {
      continue;
    }

    const rect = node.el.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const left = rect.left - canvasRect.left - 10;
    const right = rect.right - canvasRect.left + 10;
    const top = rect.top - canvasRect.top - 10;
    const bottom = rect.bottom - canvasRect.top + 10;

    if (point.x >= left && point.x <= right && point.y >= top && point.y <= bottom) {
      return node;
    }
  }

  return null;
}

function findDropSection(point) {
  for (const node of state.nodes.values()) {
    if (node.type !== 'section') {
      continue;
    }

    const distance = Math.hypot(node.x - point.x, node.y - point.y);

    if (distance < 64) {
      return node;
    }
  }

  return null;
}

function clearDropTargets() {
  for (const node of state.nodes.values()) {
    node.el.classList.remove('is-drop-target');
  }
}

function makeDraggable(node) {
  node.el.addEventListener('pointerdown', (event) => {
    if (node.type === 'core') {
      return;
    }

    const editingLabel = event.target.closest('[contenteditable]');

    if (editingLabel) {
      return;
    }

    event.preventDefault();
    node.el.setPointerCapture(event.pointerId);

    const canvasRect = canvas.getBoundingClientRect();
    const startPointer = { x: event.clientX, y: event.clientY };
    const startPosition = { x: node.x, y: node.y };
    const moved = { current: false };

    const onMove = (moveEvent) => {
      const deltaX = moveEvent.clientX - startPointer.x;
      const deltaY = moveEvent.clientY - startPointer.y;

      if (!moved.current && Math.hypot(deltaX, deltaY) < 4) {
        return;
      }

      moved.current = true;
      node.el.classList.add('is-dragging');
      hideAddStub();

      const next = clampToCanvas(startPosition.x + deltaX, startPosition.y + deltaY);

      node.x = next.x;
      node.y = next.y;
      positionNode(node);
      positionGhosts();
      redrawEdges();
      clearDropTargets();

      const pointerOnCanvas = {
        x: moveEvent.clientX - canvasRect.left,
        y: moveEvent.clientY - canvasRect.top,
      };

      if (node.type === 'thought') {
        const target = findDropGroup(pointerOnCanvas, null);

        if (target && target.id !== node.parentId) {
          target.el.classList.add('is-drop-target');
        }
      }

      if (node.type === 'group') {
        const target = findDropSection(pointerOnCanvas);

        if (target && target.id !== node.parentId) {
          target.el.classList.add('is-drop-target');
        }
      }
    };

    const onUp = (upEvent) => {
      node.el.removeEventListener('pointermove', onMove);
      node.el.removeEventListener('pointerup', onUp);
      node.el.removeEventListener('pointercancel', onUp);
      node.el.classList.remove('is-dragging');
      clearDropTargets();

      const pointerOnCanvas = {
        x: upEvent.clientX - canvasRect.left,
        y: upEvent.clientY - canvasRect.top,
      };

      if (moved.current) {
        if (node.type === 'thought') {
          const target = findDropGroup(pointerOnCanvas, null);

          if (target && target.id !== node.parentId) {
            node.parentId = target.id;
          }
        }

        if (node.type === 'group') {
          const target = findDropSection(pointerOnCanvas);

          if (target && target.id !== node.parentId) {
            node.parentId = target.id;
            removeSectionGhosts(target.id);
          }
        }

        redrawEdges();
        scheduleSave();
        return;
      }

      selectNode(node.id);
    };

    node.el.addEventListener('pointermove', onMove);
    node.el.addEventListener('pointerup', onUp);
    node.el.addEventListener('pointercancel', onUp);
  });
}

function bindAddStubSource(node) {
  node.el.addEventListener('pointerenter', () => {
    showAddStub(node);
  });
  node.el.addEventListener('pointerleave', () => {
    scheduleHideAddStub();
  });
}

function createThought(group, placement, saved = null, options = {}) {
  const spot = placement || findFreePlacement(group);
  const node = {
    id: saved?.id || nextId('thought'),
    type: 'thought',
    parentId: group.id,
    content: saved?.content || '',
    files: saved?.files ? [...saved.files] : [],
    x: spot.x,
    y: spot.y,
  };

  const el = document.createElement('div');
  const dot = document.createElement('span');
  const label = document.createElement('span');

  el.className = 'brain-node brain-thought';
  dot.className = 'brain-thought-dot';
  label.className = 'brain-thought-label is-empty';
  label.textContent = 'New thought';
  el.append(dot, label);
  node.el = el;
  canvas.append(el);
  state.nodes.set(node.id, node);
  positionNode(node);
  makeDraggable(node);
  addDeleteButton(node);
  updateThoughtLabel(node);
  redrawEdges();

  if (saved) {
    return node;
  }

  settleAround(node);

  if (options.content) {
    node.content = options.content;
    updateThoughtLabel(node);
  }

  scheduleSave();

  if (!options.silent) {
    selectNode(node.id);
  }

  return node;
}

function createGroup(section, placement, saved = null, options = {}) {
  const spot = placement || findFreePlacement(section);
  const node = {
    id: saved?.id || nextId('group'),
    type: 'group',
    parentId: section.id,
    label: saved?.label || 'Untitled',
    description: saved?.description || '',
    x: spot.x,
    y: spot.y,
  };

  const el = document.createElement('div');
  const label = document.createElement('span');

  el.className = 'brain-node brain-group';
  label.className = 'brain-group-label';
  label.textContent = node.label;
  el.append(label);
  node.el = el;

  if (node.description) {
    el.title = node.description;
    el.classList.add('has-description');
  }

  canvas.append(el);
  state.nodes.set(node.id, node);
  positionNode(node);
  makeDraggable(node);
  bindAddStubSource(node);
  addDeleteButton(node);
  el.addEventListener('dblclick', (event) => {
    event.stopPropagation();
    startTitleEdit(node);
  });
  redrawEdges();

  if (saved) {
    return node;
  }

  removeSectionGhosts(section.id);
  settleAround(node);
  scheduleSave();

  if (options.silent) {
    node.label = options.title || node.label;
    label.textContent = node.label;
  } else {
    startTitleEdit(node, () => selectNode(node.id));
  }

  return node;
}

function createSection(definition, position) {
  const node = {
    id: definition.id,
    type: 'section',
    parentId: 'core',
    label: definition.label,
    x: position.x,
    y: position.y,
  };

  const el = document.createElement('div');
  const circle = document.createElement('span');
  const label = document.createElement('span');

  el.className = 'brain-node brain-section';
  circle.className = 'brain-section-circle';
  circle.innerHTML = definition.icon;
  label.className = 'brain-section-label';
  label.textContent = definition.label;
  el.append(circle, label);
  node.el = el;
  canvas.append(el);
  state.nodes.set(node.id, node);
  positionNode(node);
  makeDraggable(node);
  bindAddStubSource(node);
  spawnSectionGhosts(node);
}

function createCore(position) {
  const node = {
    id: 'core',
    type: 'core',
    parentId: null,
    x: position.x,
    y: position.y,
  };

  const el = document.createElement('div');

  el.className = 'brain-node brain-core';
  node.el = el;
  canvas.append(el);
  state.nodes.set(node.id, node);
  positionNode(node);
}

function createAddStub() {
  const el = document.createElement('div');
  const circle = document.createElement('span');
  const label = document.createElement('span');

  el.className = 'brain-add-stub';
  el.hidden = true;
  circle.className = 'brain-add-stub-circle';
  circle.textContent = '+';
  label.className = 'brain-add-stub-label';
  label.textContent = 'Add memory';
  el.append(circle, label);
  canvas.append(el);

  el.addEventListener('pointerenter', () => {
    clearTimeout(addStub.hideTimer);
    addStub.hideTimer = null;
  });
  el.addEventListener('pointerleave', () => {
    scheduleHideAddStub();
  });
  el.addEventListener('click', () => {
    const parent = addStub.parentId ? state.nodes.get(addStub.parentId) : null;
    const placement = { x: addStub.x, y: addStub.y };

    hideAddStub();

    if (parent?.type === 'section') {
      createGroup(parent, placement);
    }

    if (parent?.type === 'group') {
      createThought(parent, placement);
    }
  });

  addStub.el = el;
  addStub.labelEl = label;
}

function bindComposer() {
  sendButton.addEventListener('click', saveSelected);
  composerInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      saveSelected();
    }

    if (event.key === 'Escape') {
      clearSelection();
      composerInput.blur();
    }
  });
  attachButton.addEventListener('click', () => {
    fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    attachFiles([...fileInput.files]);
    fileInput.value = '';
  });
  composer.addEventListener('dragover', (event) => {
    event.preventDefault();
    composer.classList.add('is-drop-ready');
  });
  composer.addEventListener('dragleave', () => {
    composer.classList.remove('is-drop-ready');
  });
  composer.addEventListener('drop', (event) => {
    event.preventDefault();
    composer.classList.remove('is-drop-ready');
    attachFiles([...(event.dataTransfer?.files || [])]);
  });
}

function serializeBrain() {
  const nodes = [];

  for (const node of state.nodes.values()) {
    if (node.type === 'core' || node.type === 'section') {
      nodes.push({ id: node.id, type: node.type, x: node.x, y: node.y });
    } else if (node.type === 'group') {
      nodes.push({
        id: node.id,
        type: 'group',
        parentId: node.parentId,
        x: node.x,
        y: node.y,
        label: node.label,
        description: node.description || '',
      });
    } else if (node.type === 'thought') {
      nodes.push({
        id: node.id,
        type: 'thought',
        parentId: node.parentId,
        x: node.x,
        y: node.y,
        content: node.content || '',
        files: node.files || [],
      });
    }
  }

  return { version: 1, counter: state.counter, nodes };
}

async function persistBrain() {
  const payload = JSON.stringify(serializeBrain());

  try {
    localStorage.setItem(STORAGE_KEY, payload);
  } catch {
    // ignore storage quota / privacy mode
  }

  for (const url of ['/api/brain', 'http://127.0.0.1:8787/api/brain']) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });

      if (response.ok) {
        return;
      }
    } catch {
      // try next url
    }
  }
}

function scheduleSave() {
  if (!state.initialized || state.restoring) {
    return;
  }

  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistBrain, 700);
}

async function loadBrain() {
  for (const url of ['/api/brain', 'http://127.0.0.1:8787/api/brain']) {
    try {
      const response = await fetch(url);

      if (response.ok) {
        const data = await response.json();

        if (data && Array.isArray(data.nodes) && data.nodes.length) {
          return data;
        }
      }
    } catch {
      // try next url
    }
  }

  try {
    const cached = localStorage.getItem(STORAGE_KEY);

    if (cached) {
      const data = JSON.parse(cached);

      if (data && Array.isArray(data.nodes) && data.nodes.length) {
        return data;
      }
    }
  } catch {
    // ignore
  }

  return null;
}

function sectionDefaults() {
  const { width, height } = canvasSize();
  const center = { x: width / 2, y: height / 2 };
  const radiusX = Math.min(Math.max(width * 0.26, 190), 360);
  const radiusY = Math.min(Math.max(height * 0.27, 150), 250);
  const positions = new Map();

  SECTIONS.forEach((definition, index) => {
    const angle = ((-90 + index * 72) * Math.PI) / 180;

    positions.set(definition.id, {
      x: center.x + Math.cos(angle) * radiusX,
      y: center.y + Math.sin(angle) * radiusY,
    });
  });

  return { center, positions };
}

function buildDefaultBrain() {
  const { center, positions } = sectionDefaults();

  createCore(center);
  SECTIONS.forEach((definition) => {
    createSection(definition, positions.get(definition.id));
  });
  positionGhosts();
  redrawEdges();
}

function restoreBrain(data) {
  state.restoring = true;
  state.counter = data.counter || 0;

  const byId = new Map(data.nodes.map((node) => [node.id, node]));
  const { center, positions } = sectionDefaults();
  const coreData = byId.get('core');
  const offsetX = coreData ? center.x - coreData.x : 0;
  const offsetY = coreData ? center.y - coreData.y : 0;

  createCore(center);

  SECTIONS.forEach((definition) => {
    const saved = byId.get(definition.id);

    createSection(
      definition,
      saved ? { x: saved.x + offsetX, y: saved.y + offsetY } : positions.get(definition.id),
    );
  });

  for (const item of data.nodes) {
    if (item.type !== 'group') {
      continue;
    }

    const section = state.nodes.get(item.parentId);

    if (section) {
      createGroup(section, { x: item.x + offsetX, y: item.y + offsetY }, item);
    }
  }

  for (const item of data.nodes) {
    if (item.type !== 'thought') {
      continue;
    }

    const group = state.nodes.get(item.parentId);

    if (group) {
      createThought(group, { x: item.x + offsetX, y: item.y + offsetY }, item);
    }
  }

  pruneGhostsForPopulatedSections();
  positionGhosts();
  redrawEdges();
  state.restoring = false;
}

function resizeDotField() {
  const { width, height } = canvasSize();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const spacing = dotField.spacing;

  dotField.width = width;
  dotField.height = height;
  dotCanvas.width = Math.round(width * dpr);
  dotCanvas.height = Math.round(height * dpr);
  dotCanvas.style.width = `${width}px`;
  dotCanvas.style.height = `${height}px`;
  dotCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  dotField.cols = Math.max(1, Math.floor(width / spacing));
  dotField.rows = Math.max(1, Math.floor(height / spacing));
  dotField.offsetX = (width - (dotField.cols - 1) * spacing) / 2;
  dotField.offsetY = (height - (dotField.rows - 1) * spacing) / 2;
  dotField.level = new Float32Array(dotField.cols * dotField.rows);
  drawDotField();
}

function drawDotField() {
  if (!dotCtx || !dotField.level) {
    return;
  }

  const { cols, rows, spacing, offsetX, offsetY, level, influenceRadius } = dotField;

  dotCtx.clearRect(0, 0, dotField.width, dotField.height);

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      const x = offsetX + col * spacing;
      const y = offsetY + row * spacing;

      let target = 0;

      if (dotField.active) {
        const distance = Math.hypot(x - dotField.mouseX, y - dotField.mouseY);

        if (distance < influenceRadius) {
          const falloff = 1 - distance / influenceRadius;

          target = falloff * falloff;
        }
      }

      const value = level[index] + (target - level[index]) * 0.18;

      level[index] = value;

      const radius = 1 + value * 2.1;

      dotCtx.beginPath();
      dotCtx.fillStyle = 'rgb(218, 218, 221)';
      dotCtx.arc(x, y, radius, 0, Math.PI * 2);
      dotCtx.fill();
    }
  }
}

function dotFieldLoop() {
  drawDotField();

  if (!dotField.active) {
    let peak = 0;

    for (let index = 0; index < dotField.level.length; index += 1) {
      if (dotField.level[index] > peak) {
        peak = dotField.level[index];
      }
    }

    if (peak < 0.01) {
      dotField.running = false;
      return;
    }
  }

  requestAnimationFrame(dotFieldLoop);
}

function startDotLoop() {
  if (dotField.running) {
    return;
  }

  dotField.running = true;
  requestAnimationFrame(dotFieldLoop);
}

function initDotField() {
  dotCanvas = document.createElement('canvas');
  dotCanvas.className = 'brain-dots';
  dotCanvas.setAttribute('aria-hidden', 'true');
  canvas.prepend(dotCanvas);
  dotCtx = dotCanvas.getContext('2d');

  resizeDotField();

  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();

    dotField.mouseX = event.clientX - rect.left;
    dotField.mouseY = event.clientY - rect.top;
    dotField.active = true;
    startDotLoop();
  });
  canvas.addEventListener('pointerleave', () => {
    dotField.active = false;
    startDotLoop();
  });
}

async function runRetrievalTest(brief) {
  let lastError = new Error('Could not reach the selector.');

  for (const url of ['/api/brain/select', 'http://127.0.0.1:8787/api/brain/select']) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief }),
      });
      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        return data;
      }

      lastError = new Error(data.error || 'Selection failed.');
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

function renderTestResults(body, data) {
  body.replaceChildren();

  const summary = document.createElement('p');

  summary.className = 'brain-test-summary';
  summary.textContent = `Picked ${data.chosen.length} of ${data.candidateCount} memories · ${data.model}`;
  body.append(summary);

  if (data.notes) {
    const notes = document.createElement('p');

    notes.className = 'brain-test-notes';
    notes.textContent = data.notes;
    body.append(notes);
  }

  if (!data.chosen.length) {
    const empty = document.createElement('p');

    empty.className = 'brain-test-empty';
    empty.textContent = 'No memories were judged relevant to this brief.';
    body.append(empty);
    return;
  }

  for (const pick of data.chosen) {
    const card = document.createElement('article');
    const head = document.createElement('p');
    const desc = document.createElement('p');
    const reason = document.createElement('p');

    card.className = 'brain-test-pick';
    head.className = 'brain-test-pick-head';
    head.textContent = [pick.section, pick.group].filter(Boolean).join('  ·  ');
    desc.className = 'brain-test-pick-desc';
    desc.textContent = pick.description || '(no description)';
    reason.className = 'brain-test-pick-reason';
    reason.textContent = pick.reason;
    card.append(head, desc, reason);

    if (pick.files.length) {
      const files = document.createElement('div');

      files.className = 'brain-test-files';

      for (const file of pick.files) {
        const chip = document.createElement('span');

        chip.className = 'brain-test-file';
        chip.textContent = file.name;
        files.append(chip);
      }

      card.append(files);
    }

    body.append(card);
  }
}

function createTestPanel() {
  const root = document.querySelector('#brain-window');

  if (!root) {
    return;
  }

  const toggle = document.createElement('button');
  const panel = document.createElement('div');
  const header = document.createElement('div');
  const title = document.createElement('p');
  const closeButton = document.createElement('button');
  const briefInput = document.createElement('textarea');
  const runButton = document.createElement('button');
  const body = document.createElement('div');

  toggle.type = 'button';
  toggle.className = 'brain-test-toggle';
  toggle.textContent = 'Test retrieval';
  panel.className = 'brain-test-panel';
  panel.hidden = true;
  header.className = 'brain-test-header';
  title.className = 'brain-test-title';
  title.textContent = 'Test retrieval (GPT)';
  closeButton.type = 'button';
  closeButton.className = 'brain-test-close';
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.textContent = '×';
  briefInput.className = 'brain-test-brief';
  briefInput.rows = 2;
  briefInput.placeholder = 'Run brief — e.g. competitive Baloot ad for Saudi players';
  runButton.type = 'button';
  runButton.className = 'brain-test-run';
  runButton.textContent = 'Find relevant files';
  body.className = 'brain-test-body';
  header.append(title, closeButton);
  panel.append(header, briefInput, runButton, body);
  root.append(toggle, panel);

  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;

    if (!panel.hidden) {
      briefInput.focus();
    }
  });
  closeButton.addEventListener('click', () => {
    panel.hidden = true;
  });
  runButton.addEventListener('click', async () => {
    const brief = briefInput.value.trim();

    if (!brief) {
      briefInput.focus();
      return;
    }

    runButton.disabled = true;
    body.replaceChildren();

    const loading = document.createElement('p');

    loading.className = 'brain-test-loading';
    loading.textContent = 'Asking the model…';
    body.append(loading);

    try {
      const data = await runRetrievalTest(brief);

      renderTestResults(body, data);
    } catch (error) {
      body.replaceChildren();

      const message = document.createElement('p');

      message.className = 'brain-test-error';
      message.textContent = error.message;
      body.append(message);
    } finally {
      runButton.disabled = false;
    }
  });
}

export async function initBrainWindow() {
  if (state.initialized) {
    return;
  }

  canvas = document.querySelector('#brain-canvas');
  edgesSvg = document.querySelector('#brain-edges');
  composer = document.querySelector('#brain-composer');
  composerInput = document.querySelector('#brain-input');
  composerChips = document.querySelector('#brain-chips');
  attachButton = document.querySelector('#brain-attach');
  sendButton = document.querySelector('#brain-send');
  fileInput = document.querySelector('#brain-file-input');

  if (!canvas || !edgesSvg || !composer) {
    return;
  }

  state.initialized = true;

  initDotField();
  createAddStub();
  createDeletePopover();
  createTestPanel();
  bindComposer();

  canvas.addEventListener('pointerdown', (event) => {
    hideDeleteConfirm();

    if (event.target === canvas || event.target === edgesSvg || event.target.closest('.brain-header')) {
      clearSelection();
    }
  });

  new ResizeObserver(() => {
    resizeDotField();
    centerBrainInCanvas();
    redrawEdges();
  }).observe(canvas);

  const saved = await loadBrain();

  if (saved) {
    restoreBrain(saved);
  } else {
    buildDefaultBrain();
  }
}
