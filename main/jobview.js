// Turn Claude's JSONL subagent log into items for the job view.
function parseClaudeTranscript(text, options = {}) {
  try {
    const maxResult = Number.isInteger(options?.maxResult) && options.maxResult >= 0 ? options.maxResult : 4096;
    const items = [];
    const tools = new Map();
    for (const line of String(text || '').split('\n')) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (!event || typeof event !== 'object') continue;
      const content = event.message?.content;
      const ts = event.timestamp || null;
      if (event.type === 'user' && typeof content === 'string') {
        items.push({ kind: 'user', ts, text: content });
      } else if (event.type === 'assistant' && Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text' && typeof block.text === 'string') items.push({ kind: 'text', ts, text: block.text });
          if (block.type === 'thinking' && typeof block.thinking === 'string') items.push({ kind: 'thinking', ts, text: block.thinking });
          if (block.type === 'tool_use' && typeof block.id === 'string') {
            const input = block.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input : {};
            const name = typeof block.name === 'string' ? block.name : '';
            const detail = ['command', 'file_path', 'pattern', 'path', 'query'].map((key) => input[key]).find((value) => typeof value === 'string') || name;
            const summary = detail.replace(/\s+/g, ' ').trim().slice(0, 120);
            const item = { kind: 'tool', ts, id: block.id, name, input, summary, result: null };
            items.push(item);
            tools.set(block.id, item);
          }
        }
      } else if (event.type === 'user' && Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'tool_result') continue;
          const tool = tools.get(block.tool_use_id);
          if (!tool) continue;
          const body = block.content;
          const resultText = typeof body === 'string' ? body : Array.isArray(body) ? body.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('') : '';
          tool.result = { text: resultText.slice(0, maxResult), truncated: resultText.length > maxResult, isError: !!block.is_error, size: resultText.length };
        }
      }
    }
    return items;
  } catch { return []; }
}

// Turn Codex's --json event stream into the same tool and message rows.
function parseCodexEvents(text, options = {}) {
  try {
    const maxOutput = Number.isInteger(options?.maxOutput) && options.maxOutput >= 0 ? options.maxOutput : 4096;
    const items = [];
    const tools = new Map();
    for (const line of String(text || '').split('\n')) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
      const type = event.type;
      if (type === 'item.started' || type === 'item.completed') {
        const item = event.item;
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          items.push({ kind: 'event', type });
          continue;
        }
        const id = typeof item.id === 'string' ? item.id : null;
        if (item.type === 'command_execution') {
          let tool = id === null ? null : tools.get(id);
          const command = typeof item.command === 'string' ? item.command : tool?.input.command || '';
          if (!tool) {
            tool = { kind: 'tool', id, name: 'shell', summary: '', input: { command }, result: null };
            items.push(tool);
            if (id !== null) tools.set(id, tool);
          }
          tool.input = { command };
          tool.summary = command.replace(/\s+/g, ' ').trim().slice(0, 120);
          if (type === 'item.completed') {
            const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
            const exitCode = typeof item.exit_code === 'number' ? item.exit_code : null;
            tool.result = { text: output.slice(0, maxOutput), truncated: output.length > maxOutput,
              isError: exitCode !== null && exitCode !== 0, size: output.length, exitCode };
          }
        } else if (item.type === 'file_change') {
          let tool = id === null ? null : tools.get(id);
          const changes = Array.isArray(item.changes) ? item.changes : tool?.input.changes || [];
          if (!tool) {
            tool = { kind: 'tool', id, name: 'file_change', summary: '', input: { changes }, result: null };
            items.push(tool);
            if (id !== null) tools.set(id, tool);
          }
          tool.input = { changes };
          tool.summary = changes.length + ' files';
          if (type === 'item.completed') tool.result = { text: '', truncated: false, isError: item.status === 'failed', size: 0, exitCode: null };
        } else if (type === 'item.completed' && item.type === 'agent_message') {
          if (typeof item.text === 'string') items.push({ kind: 'text', text: item.text });
        } else if (type === 'item.completed' && item.type === 'reasoning') {
          if (typeof item.text === 'string') items.push({ kind: 'thinking', text: item.text });
        } else if (item.type !== 'agent_message' && item.type !== 'reasoning') {
          items.push({ kind: 'event', type });
        }
      } else if (type === 'turn.completed') {
        const usage = event.usage && typeof event.usage === 'object' && !Array.isArray(event.usage) ? event.usage : {};
        items.push({ kind: 'usage', usage });
      } else if (type === 'error' || type === 'turn.failed') {
        const message = [event.message, event.error?.message, event.detail].find((value) => typeof value === 'string');
        items.push({ kind: 'error', text: message || '' });
      } else {
        items.push({ kind: 'event', type });
      }
    }
    return items;
  } catch { return []; }
}

module.exports = { parseClaudeTranscript, parseCodexEvents };
