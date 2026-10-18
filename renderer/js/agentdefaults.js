// Controls and option lists shared by app-wide and per-project agent settings.
(function () {
  const h = App.h;
  const effortNames = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
  const effortOptions = (levels) => [{ value: '', label: 'Default' }, ...levels.map((value) => ({ value, label: effortNames[value] }))];

  App.agentDefaultOptions = (codexModels = []) => {
    const command = ((App.cfg.agents || []).find((agent) => /^claude(\s|$)/.test(agent.cmd)) || { cmd: 'claude' }).cmd;
    const fromCommand = (command.match(/--model(?:=|\s+)(\S+)/) || [])[1];
    return {
      model: [{ value: '', label: fromCommand ? `From the command (${fromCommand})` : 'Claude Code default' },
        { value: 'opus', label: 'Opus (latest)' }, { value: 'sonnet', label: 'Sonnet (latest)' }, { value: 'haiku', label: 'Haiku (latest)' },
        { value: 'claude-fable-5-1', label: 'Fable 5.1' }, { value: 'claude-opus-5-5', label: 'Opus 5.5' },
        { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }, { value: 'claude-haiku-5-5', label: 'Haiku 5.5' }],
      effort: effortOptions(['low', 'medium', 'high', 'xhigh', 'max']),
      codexModel: [{ value: '', label: 'Codex default' }, ...codexModels.map((model) => ({ value: model.id, label: model.label }))],
      codexEffort: effortOptions(['minimal', 'low', 'medium', 'high', 'xhigh']),
      mode: [{ value: '', label: 'As last used' }, { value: 'default', label: 'Default' }, { value: 'acceptEdits', label: 'Accept edits' },
        { value: 'auto', label: 'Auto' }, { value: 'plan', label: 'Plan' }],
      engine: [{ value: '', label: 'Claude' }, { value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }]
    };
  };

  App.policyControl = (item, value, onPick, disabled = false) => item.type === 'bool'
    ? h('button.ps-switch', { type: 'button', role: 'switch', 'aria-label': item.label,
      'aria-checked': value === 'on' ? 'true' : 'false', disabled,
      onclick: () => onPick(value === 'on' ? 'off' : 'on') }, h('span.ps-switch-thumb'))
    : h('div.ps-segments', { role: 'radiogroup', 'aria-label': item.label },
      item.options.map((option) => h('button', { type: 'button', role: 'radio',
        'aria-checked': option.value === value ? 'true' : 'false', disabled,
        onclick: () => onPick(option.value) }, option.label)));
})();
