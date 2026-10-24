import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { BACKEND_URL, DATABASE_URL } from "./env.ts";

/**
 * Rows no browser can create. There is no Linear in the e2e stack, so a
 * Linear connection and the sessions it would mirror are written straight to
 * the e2e database — the shapes the webhook path writes, with every activity
 * already `sent` and every turn already over, so no clock tries to reach
 * Linear for them. From there it is the real server: the pages read these
 * rows over HTTP, and a cancel goes through the real action.
 *
 * Written with Bun's SQL client in a child process, because Playwright runs
 * under Node and the frontend carries no Postgres driver.
 */

/** Who is signed in on a page, and their first project. */
export async function whoAmI(
  page: Page,
): Promise<{ userId: number; projectId: number }> {
  const me = await (await page.request.get(`${BACKEND_URL}/api/me`)).json();
  const list = await (
    await page.request.get(`${BACKEND_URL}/api/projects?limit=1`)
  ).json();
  return { userId: Number(me.user.id), projectId: Number(list.projects[0].id) };
}

/** One seeded session. */
export interface SeededSession {
  id: number;
  identifier: string;
}

/**
 * Run a script against the e2e database and return what it printed as JSON.
 * @param script - The body; `sql` and `input` are in scope.
 * @param input - Values the script reads.
 * @returns The parsed output.
 */
function runSql<T>(script: string, input: Record<string, unknown>): T {
  const program = `
    import { SQL } from "bun";
    const sql = new SQL(process.env.DATABASE_URL);
    const input = JSON.parse(process.env.SEED_INPUT);
    const out = await (async () => { ${script} })();
    await sql.close();
    console.log(JSON.stringify(out));
  `;
  const stdout = execFileSync("bun", ["-e", program], {
    env: { ...process.env, DATABASE_URL, SEED_INPUT: JSON.stringify(input) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(String(stdout).trim().split("\n").pop() ?? "null") as T;
}

/**
 * Connect the signed-in user's project to a pretend Linear workspace and
 * mirror one finished worker session on it: a delegation, the
 * acknowledgement, a replaced ephemeral thought, an action with a long
 * result, a plan, a pull request link, a response, and its one completed
 * turn and what it cost. With `awaiting`, the session ends on a question instead.
 * @param page - The signed-in page.
 * @param options - `awaiting` to end on an elicitation.
 * @returns The session.
 */
export async function seedSession(
  page: Page,
  options: { awaiting?: boolean } = {},
): Promise<SeededSession> {
  const { projectId } = await whoAmI(page);
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return runSql<SeededSession>(
    `
    const { projectId, nonce, awaiting } = input;
    let [integration] = await sql\`SELECT id FROM integrations WHERE project_id = \${projectId} AND type = 'linear'\`;
    if (!integration) {
      [integration] = await sql\`INSERT INTO integrations
        (project_id, type, external_workspace_id, workspace_name, workspace_url_key,
         external_app_user_id, app_user_name, details, oauth_client_id, scopes, status)
        VALUES (\${projectId}, 'linear', \${'ws-' + nonce}, 'Acme', \${'acme-' + nonce},
         \${'app-' + nonce}, 'hypotenuse', \${JSON.stringify({ appUserCapabilities: {}, teamIds: ['t1'], canAccessAllPublicTeams: false })}::jsonb,
         'client', \${JSON.stringify(['read', 'write'])}::jsonb, 'active')
        RETURNING id\`;
    }
    const identifier = 'ENG-' + Math.floor(Math.random() * 90000 + 10000);
    const plan = [
      { content: 'Read the handler', status: 'completed' },
      { content: 'Add retry', status: awaiting ? 'inProgress' : 'completed' },
    ];
    const links = [
      { label: 'Hypotenuse', url: 'https://hypotenuse.test/sessions' },
      { label: 'Pull request #418', url: 'https://github.com/acme/web/pull/418' },
    ];
    const [session] = await sql\`INSERT INTO agent_sessions
      (project_id, type, integration_id, external_session_id, external_url, external_issue_id,
       issue_identifier, issue_title, issue_url, team_key, creator_external_user_id, creator_name,
       origin, role, status, plan, external_urls)
      VALUES (\${projectId}, 'linear', \${integration.id}, \${'s-' + nonce}, 'https://linear.app/acme/session',
       \${'i-' + nonce}, \${identifier}, 'Add retry to webhook ingress', 'https://linear.app/acme/issue',
       'ENG', 'u1', 'Evan Example', 'delegation', 'worker', \${awaiting ? 'awaitingInput' : 'complete'},
       \${JSON.stringify(plan)}::jsonb, \${JSON.stringify(links)}::jsonb)
      RETURNING id\`;
    const start = Date.now() - 600000;
    const [item] = await sql\`INSERT INTO work_items (project_id, agent_session_id, kind, role, status,
      repository_resolved, queued_at, claimed_at, finished_at, created_at, agent_id, traceparent)
      VALUES (\${projectId}, \${session.id}, 'session_created', 'worker', 'completed', true,
       \${new Date(start)}, \${new Date(start + 2000)}, \${new Date(start + 372000)}, \${new Date(start)}, 'codex',
       '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00')
      RETURNING id\`;
    await sql\`INSERT INTO cost_records (project_id, agent_session_id, root_agent_session_id,
      work_item_id, kind, role, issue_identifier, runner_name, agent_id, ending,
      input_tokens, output_tokens, cost_usd, claimed_at, ended_at)
      VALUES (\${projectId}, \${session.id}, \${session.id}, \${item.id}, 'session_created', 'worker',
       \${identifier}, 'seed-laptop', 'codex', 'completed', 1200, 300, 0.42,
       \${new Date(start + 2000)}, \${new Date(start + 372000)})\`;
    const long = Array.from({ length: 12 }, (_, i) => 'result line ' + (i + 1)).join('\\n');
    const rows = [
      ['inbound', 'prompt', { type: 'prompt', body: 'please take this' }, false, 'received', null, null],
      ['outbound', 'thought', { type: 'thought', body: 'On it.' }, false, 'sent', null, null],
      ['outbound', 'thought', { type: 'thought', body: 'Reading the ingress handler' }, true, 'sent', null, null],
      ['outbound', 'action', { type: 'action', action: 'Ran', parameter: 'bun test', result: long }, false, 'sent', null, null],
      awaiting
        ? ['outbound', 'elicitation', { type: 'elicitation', body: 'Allow \`bun test\` to run?' }, false, 'sent', 'select', { options: [{ label: 'Allow once' }, { label: 'Deny' }] }]
        : ['outbound', 'response', { type: 'response', body: 'Added **retry** with backoff.' }, false, 'sent', null, null],
    ];
    let seq = 0;
    for (const [direction, type, content, ephemeral, status, signal, metadata] of rows) {
      seq++;
      await sql\`INSERT INTO agent_activities
        (agent_session_id, seq, direction, kind, content_type, content, ephemeral, signal,
         signal_metadata, client_activity_id, delivery_status, sent_at, created_at)
        VALUES (\${session.id}, \${seq}, \${direction}, 'activity', \${type}, \${JSON.stringify(content)}::jsonb, \${ephemeral},
         \${signal}, \${metadata === null ? null : JSON.stringify(metadata)}::jsonb, \${crypto.randomUUID()}, \${status},
         \${new Date(start + seq * 1000)}, \${new Date(start + seq * 1000)})\`;
    }
    return { id: session.id, identifier };
  `,
    { projectId, nonce, awaiting: Boolean(options.awaiting) },
  );
}

/** The events seeded for one session. */
export interface SeededEvents {
  session: SeededSession;
  /** The delegation that started the session, handled and routed. */
  createdId: number;
  /** An issue change Hypotenuse did not act on. */
  ignoredId: number;
}

/**
 * Seed a session (see {@link seedSession}) and the two webhook deliveries an
 * event log would hold for it: the `AgentSessionEvent` `created` that started
 * it, linked to the session and its turn and routed by a rule, and an `Issue`
 * update that was ignored. Both already processed, as `triggers:process-event`
 * leaves them.
 * @param page - The signed-in page.
 * @returns The session and the two event ids.
 */
export async function seedEvents(page: Page): Promise<SeededEvents> {
  const session = await seedSession(page);
  const ids = runSql<{ createdId: number; ignoredId: number }>(
    `
    const { sessionId } = input;
    const [s] = await sql\`SELECT integration_id, issue_identifier FROM agent_sessions WHERE id = \${sessionId}\`;
    const [turn] = await sql\`SELECT id FROM work_items WHERE agent_session_id = \${sessionId} ORDER BY id LIMIT 1\`;
    await sql\`UPDATE agent_sessions SET routing_rule_name = '/work' WHERE id = \${sessionId}\`;
    const at = new Date(Date.now() - 600000);
    const created = { type: 'AgentSessionEvent', action: 'created', agentSession: { id: 's', issue: { identifier: s.issue_identifier } } };
    const [c] = await sql\`INSERT INTO trigger_events
      (type, delivery_id, integration_id, event_type, action, webhook_timestamp, payload, received_at,
       processed_at, outcome, summary, agent_session_id, work_item_id)
      VALUES ('linear', \${crypto.randomUUID()}, \${s.integration_id}, 'AgentSessionEvent', 'created', \${at},
       \${JSON.stringify(created)}::text::jsonb, \${at}, \${at}, 'handled',
       \${'Started a session on ' + s.issue_identifier + ', acknowledged it, and queued its first turn for routing.'},
       \${sessionId}, \${turn.id})
      RETURNING id\`;
    const later = new Date(Date.now() - 60000);
    const issue = { type: 'Issue', action: 'update', data: { identifier: s.issue_identifier, title: 'Renamed' }, updatedFrom: { title: 'Old' } };
    const [i] = await sql\`INSERT INTO trigger_events
      (type, delivery_id, integration_id, event_type, action, webhook_timestamp, payload, received_at,
       processed_at, outcome, summary)
      VALUES ('linear', \${crypto.randomUUID()}, \${s.integration_id}, 'Issue', 'update', \${later},
       \${JSON.stringify(issue)}::text::jsonb, \${later}, \${later}, 'ignored',
       \${'Ignored: a change to ' + s.issue_identifier + ' that neither removed @hypotenuse as delegate nor closed it.'})
      RETURNING id\`;
    return { createdId: c.id, ignoredId: i.id };
  `,
    { sessionId: session.id },
  );
  return { session, ...ids };
}
