// Pure selection and grouping helpers shared by the editor and tests.
const TabGroups = (() => {
  const chatCode = typeof module !== 'undefined' && module.exports ? require('./chat-code') : App.chatCode;
  const copy = (group) => ({ ...group, ids: [...group.ids] });

  function rangeSelect(orderedIds, anchorId, clickedId) {
    const anchor = orderedIds.indexOf(anchorId), clicked = orderedIds.indexOf(clickedId);
    if (anchor < 0 || clicked < 0) return [clickedId];
    return orderedIds.slice(Math.min(anchor, clicked), Math.max(anchor, clicked) + 1);
  }

  function toggleSelect(selectedIds, id) {
    return selectedIds.includes(id) ? selectedIds.filter((selected) => selected !== id) : [...selectedIds, id];
  }

  function removeMembers(groups, ids, exceptCode) {
    const removed = new Set(ids), remaining = [], dissolved = [];
    for (const group of groups) {
      const next = { ...group, ids: group.code === exceptCode ? [...group.ids] : group.ids.filter((id) => !removed.has(id)) };
      if (next.ids.length < 2 && next.ids.length !== group.ids.length) dissolved.push(next);
      else remaining.push(next);
    }
    return { groups: remaining, dissolved };
  }

  function createGroup(groups, memberIds, takenCodes, name = 'Group') {
    const ids = [...new Set(memberIds)];
    if (!ids.length) throw new Error('A tab group needs at least one member.');
    const code = chatCode.generate(new Set([...(takenCodes || []), ...groups.map((group) => group.code)]));
    const group = { code, name, ids };
    return { groups: [...removeMembers(groups, ids).groups, group], group };
  }

  function addToGroup(groups, code, ids) {
    const target = groups.find((group) => group.code === code);
    if (!target) throw new Error('Unknown tab group: ' + code);
    const moved = [...new Set(ids)];
    const remaining = removeMembers(groups, moved, code).groups;
    return remaining.map((group) => group.code === code
      ? { ...group, ids: [...new Set([...group.ids, ...moved])] } : group);
  }

  function removeFromGroup(groups, ids) {
    return removeMembers(groups, ids).groups;
  }

  function ungroup(groups, code) {
    return groups.filter((group) => group.code !== code).map(copy);
  }

  function renameGroup(groups, code, name) {
    return groups.map((group) => ({ ...group, name: group.code === code ? name : group.name, ids: [...group.ids] }));
  }

  function removeTab(groups, id) {
    return removeMembers(groups, [id]);
  }

  function groupOf(groups, id) {
    return groups.find((group) => group.ids.includes(id)) || null;
  }

  function layout(orderedIds, groups) {
    const items = [], placed = new Set();
    for (const id of orderedIds) {
      const group = groupOf(groups, id);
      if (!group) items.push({ type: 'tab', id });
      else if (!placed.has(group.code)) { items.push({ type: 'group', group }); placed.add(group.code); }
    }
    return items;
  }

  function serialise(groups, pathOf) {
    return groups.map((group) => ({
      code: group.code, name: group.name,
      files: group.ids.map((id) => pathOf(id)).filter((path) => typeof path === 'string')
    }));
  }

  return { rangeSelect, toggleSelect, createGroup, addToGroup, removeFromGroup, ungroup,
    renameGroup, removeTab, groupOf, layout, serialise };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TabGroups;
if (typeof App !== 'undefined') App.tabGroups = TabGroups;
