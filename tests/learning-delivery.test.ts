import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CopilotKitIntelligence,
  LearnedSkillsError,
} from '@copilotkit/runtime/v2';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { chat } from '@tanstack/ai';
import { DotAgent } from '../src/server/dot-agent.js';
import { completion } from './fixtures/model-stream.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

vi.mock('@tanstack/ai', { spy: true });
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it('TanStack AI streams with the verified skill catalog and authorized server tools', async () => {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  try {
    const dot = workspace.dots()[0];
    workspace.updateDot(dot.id, {
      ...dot,
      learningContainerId: 'research',
      skillDeliveryEnabled: true,
    });
    workspace.bindThread('thread', dot.id, 'Learning');
    const bytes = readFileSync(
      new URL('./fixtures/learning-skills.zip', import.meta.url),
    );
    vi.spyOn(
      CopilotKitIntelligence.prototype,
      'getLearnedSkillsSnapshots',
    ).mockResolvedValue([
      {
        containerId: 'research',
        status: 'snapshot',
        bytes,
        revision: 'fixture-v1',
        etag: `"${createHash('sha256').update(bytes).digest('hex')}"`,
        contentType: 'application/zip',
      },
    ]);
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        completion(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'load-skill',
                type: 'function',
                function: {
                  name: 'copilotkit_load_skill',
                  arguments: JSON.stringify({
                    skill_name: 'research/evidence-review',
                  }),
                },
              },
            ],
          },
          'tool_calls',
        ),
      )
      .mockResolvedValueOnce(
        completion({ role: 'assistant', content: 'Ready to review evidence.' }),
      );
    const agent = new DotAgent(
      store,
      workspace,
      {
        intelligenceKey: 'fixture',
        apiKey: 'fixture',
        model: 'fixture',
        baseUrl: 'https://unused.invalid',
        runtimeUrl: '',
        voiceName: 'marin',
        slackUsers: [],
      },
      dot.id,
    );
    const events = await lastValueFrom(
      agent
        .run({
          threadId: 'thread',
          runId: 'run',
          messages: [
            { id: 'message', role: 'user', content: 'Review the evidence.' },
          ],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        })
        .pipe(toArray()),
    );
    expect(JSON.stringify(events)).toContain('Ready to review evidence.');
    expect(chat).toHaveBeenCalledTimes(1);
    expect(network).toHaveBeenCalledTimes(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: 'load-skill',
          content: expect.stringContaining('evidence-review'),
        }),
      ]),
    );
    const request = String(network.mock.calls[0][1]?.body);
    expect(request).toContain('evidence-review');
    expect(request).toContain('copilotkit_load_skill');
    expect(request).toContain('copilotkit_read_skill_file');
    expect(request).toContain('read_space_page');
    expect(request).toContain(
      'Use only the tools provided in this conversation',
    );
  } finally {
    workspace.close();
    store.close();
  }
});

it('native skill delivery fails the invocation before contacting the model when delivery is denied', async () => {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  try {
    const dot = workspace.dots()[0];
    workspace.updateDot(dot.id, {
      ...dot,
      learningContainerId: 'research',
      skillDeliveryEnabled: true,
    });
    workspace.bindThread('thread', dot.id, 'Learning');
    const delivery = vi
      .spyOn(CopilotKitIntelligence.prototype, 'getLearnedSkillsSnapshots')
      .mockRejectedValue(new LearnedSkillsError('DELIVERY_DISABLED', false));
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected network request'));
    const agent = new DotAgent(
      store,
      workspace,
      {
        intelligenceKey: 'fixture',
        apiKey: 'fixture',
        model: 'fixture',
        baseUrl: 'https://unused.invalid',
        runtimeUrl: '',
        voiceName: 'marin',
        slackUsers: [],
      },
      dot.id,
    );
    const input: RunAgentInput = {
      threadId: 'thread',
      runId: 'run',
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    };
    await expect(
      lastValueFrom(agent.run(input).pipe(toArray())),
    ).rejects.toMatchObject({ code: 'DELIVERY_DISABLED' });
    expect(delivery).toHaveBeenCalledWith(
      expect.objectContaining({ containers: [{ containerId: 'research' }] }),
    );
    expect(network).not.toHaveBeenCalled();
  } finally {
    workspace.close();
    store.close();
  }
});

it('connects to Learning Space "research-assistant", discovers skills, loads SKILL.md, and reads supporting files', async () => {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  try {
    const dot = workspace.dots()[0];
    workspace.updateDot(dot.id, {
      ...dot,
      learningContainerId: 'research-assistant',
      skillDeliveryEnabled: true,
    });
    workspace.bindThread('thread-research', dot.id, 'Research thread');

    const bytes = readFileSync(
      new URL('./fixtures/learning-skills-with-files.zip', import.meta.url),
    );
    const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;

    const getSnapshotsSpy = vi
      .spyOn(CopilotKitIntelligence.prototype, 'getLearnedSkillsSnapshots')
      .mockResolvedValue([
        {
          containerId: 'research-assistant',
          status: 'snapshot',
          bytes,
          revision: 'fixture-v2',
          etag,
          contentType: 'application/zip',
        },
      ]);

    const network = vi
      .spyOn(globalThis, 'fetch')
      // Step 1: Model sees catalog and decides to load the skill
      .mockResolvedValueOnce(
        completion(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call-load-skill',
                type: 'function',
                function: {
                  name: 'copilotkit_load_skill',
                  arguments: JSON.stringify({
                    skill_name: 'research-assistant/evidence-review',
                  }),
                },
              },
            ],
          },
          'tool_calls',
        ),
      )
      // Step 2: After loading SKILL.md, model decides to read supporting reference file
      .mockResolvedValueOnce(
        completion(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call-read-file',
                type: 'function',
                function: {
                  name: 'copilotkit_read_skill_file',
                  arguments: JSON.stringify({
                    skill_name: 'research-assistant/evidence-review',
                    path: 'references/guide.md',
                  }),
                },
              },
            ],
          },
          'tool_calls',
        ),
      )
      // Step 3: Model returns final answer
      .mockResolvedValueOnce(
        completion({
          role: 'assistant',
          content: 'Evidence reviewed using supporting guide.',
        }),
      );

    const agent = new DotAgent(
      store,
      workspace,
      {
        intelligenceKey: 'test-key',
        apiKey: 'test-model-key',
        model: 'test-model',
        baseUrl: 'https://unused.invalid',
        runtimeUrl: '',
        voiceName: 'marin',
        slackUsers: [],
      },
      dot.id,
    );

    const events = await lastValueFrom(
      agent
        .run({
          threadId: 'thread-research',
          runId: 'run-1',
          messages: [
            { id: 'm1', role: 'user', content: 'Please review research evidence.' },
          ],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        })
        .pipe(toArray()),
    );

    // Verify snapshot request was made for container 'research-assistant'
    expect(getSnapshotsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        containers: [expect.objectContaining({ containerId: 'research-assistant' })],
      }),
    );

    // Verify model received the catalog with qualified name
    const firstRequestBody = String(network.mock.calls[0][1]?.body);
    expect(firstRequestBody).toContain('research-assistant/evidence-review');
    expect(firstRequestBody).toContain('copilotkit_load_skill');
    expect(firstRequestBody).toContain('copilotkit_read_skill_file');

    // Verify SKILL.md was loaded and emitted
    const skillLoadResult = events.find(
      (e) => e.type === EventType.TOOL_CALL_RESULT && e.toolCallId === 'call-load-skill',
    );
    expect(skillLoadResult).toBeDefined();
    expect(skillLoadResult && 'content' in skillLoadResult ? skillLoadResult.content : '').toContain(
      'Compare sources and clearly identify uncertainty',
    );

    // Verify supporting file references/guide.md was read
    const fileReadResult = events.find(
      (e) => e.type === EventType.TOOL_CALL_RESULT && e.toolCallId === 'call-read-file',
    );
    expect(fileReadResult).toBeDefined();
    expect(fileReadResult && 'content' in fileReadResult ? fileReadResult.content : '').toContain(
      'Supporting Guide',
    );
    expect(fileReadResult && 'content' in fileReadResult ? fileReadResult.content : '').toContain(
      'Always verify cross-references in evidence',
    );

    // Verify final message
    expect(JSON.stringify(events)).toContain(
      'Evidence reviewed using supporting guide.',
    );
  } finally {
    workspace.close();
    store.close();
  }
});
