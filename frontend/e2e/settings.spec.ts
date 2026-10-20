import { expect, type Page, test } from "@playwright/test";

/**
 * The project settings area in a real browser: an admin renames the project,
 * changes the sandbox provider and concurrency limit, connects a credential and
 * sees only its last four characters back, and the change lands in the audit log
 * without the value.
 *
 * `/settings` is a sidebar of sections at `/settings/<slug>`, the same shape the
 * agent editor has, so every test here opens the section it is about — and a
 * failure appears inside that section's own card rather than in a page-level alert
 * above eight of them.
 *
 * Like the other specs, this shares one backend with every suite and cannot clear
 * its database, so it mints unique addresses and asserts on rows it created.
 */

const PASSWORD = "password123";

/** Generous landing timeout; see `auth.spec.ts` for why signup is four round trips. */
const LANDED = { timeout: 10_000 };

/**
 * A unique-per-run email, so repeat runs never collide on the unique index.
 * @param label - A human-readable prefix.
 * @returns An email address nobody else in this run will use.
 */
function uniqueEmail(label: string): string {
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  return `${label}-${nonce}@toolexec.test`;
}

/**
 * Sign up through the real form and wait for the app to land in settings.
 *
 * The landing signal is the sidebar rather than any one card: it renders before
 * `project:view` resolves, which is exactly the "we are on the page" moment, and it
 * does not move when the default section changes.
 * @param page - The Playwright page.
 * @param name - The display name.
 * @param email - The email to register.
 */
async function signUp(page: Page, name: string, email: string): Promise<void> {
  await page.goto("/sign-up");
  await page.getByTestId("name").fill(name);
  await page.getByTestId("email").fill(email);
  await page.getByTestId("password").fill(PASSWORD);
  await page.getByTestId("confirm").fill(PASSWORD);
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("project-home")).toBeVisible(LANDED);
  await page.getByTestId("project-menu").getByRole("button").click();
  await page.getByTestId("settings-link").click();
  await expect(page.getByTestId("settings-section-nav")).toBeVisible(LANDED);
  // ...and wait for the index route's redirect to settle. The sidebar renders from
  // the parent route, so it is clickable while the URL is still `/settings` — and a
  // section click that lands in that window is undone by the `<Navigate replace>`
  // arriving a moment later, which reads as the sidebar not working.
  await expect(page).toHaveURL(/\/settings\/[a-z-]+$/, LANDED);
}

/**
 * Open one settings section.
 * @param page - The Playwright page.
 * @param slug - The section's slug, e.g. `"sandbox"`.
 */
async function openSection(page: Page, slug: string): Promise<void> {
  await page.getByTestId(`section-${slug}`).click();
  await expect(page).toHaveURL(new RegExp(`/${slug}$`), LANDED);
}

test.describe("project settings", () => {
  test("every section is listed, and one is mounted at a time", async ({
    page,
  }) => {
    await signUp(page, "Navvy Nadia", uniqueEmail("nav"));

    // Listed rather than gated on standing, admin-only sections included: a deep
    // link mounts the section whatever the sidebar says, so the notice has to be
    // inside the card anyway, and gating the list would flash it disabled→enabled
    // for every admin on every load.
    for (const slug of [
      "general",
      "mcp",
      "members",
      "tags",
      "sandbox",
      "ledger",
      "model",
      "git-providers",
      "danger",
    ]) {
      await expect(page.getByTestId(`section-${slug}`)).toBeVisible();
    }

    // `/settings` redirects to the default section rather than rendering all nine.
    await expect(page).toHaveURL(/\/settings\/general$/);
    await expect(page.getByTestId("project-name-card")).toBeVisible(LANDED);
    await expect(page.getByTestId("sandbox-settings")).toHaveCount(0);

    // A typo'd bookmark says so, inside the settings chrome, rather than falling
    // through to the app-level catch-all.
    await page.goto("/settings/nonsense");
    await expect(page.getByTestId("no-such-section")).toBeVisible(LANDED);
    await expect(page.getByTestId("settings-section-nav")).toBeVisible();
  });

  test("an admin edits the sandbox settings and they survive a reload", async ({
    page,
  }) => {
    await signUp(page, "Settings Sam", uniqueEmail("settings"));

    await openSection(page, "sandbox");
    await expect(page.getByTestId("sandbox-settings")).toBeVisible(LANDED);

    // The defaults a project gets from `getOrCreateSettings` on first read —
    // there is no backfill migration, so this row is created by this request.
    await expect(page.getByTestId("sandbox-provider")).toHaveValue("docker");
    await expect(page.getByTestId("concurrency-limit")).toHaveValue("3");

    // Two rounds still land underneath this form — the section's own
    // `project:settings-view` and the shell's `connection:list` — so waiting for
    // the card is not waiting for the page. Type before the second arrives and a
    // re-render lands mid-edit, which is what this used to do: it filled 7 and
    // posted 3. Selecting `vercel` is how the second round is proven to have
    // resolved, since this warning cannot render without `connections`; it also
    // leaves the draft edited before the fill, which is a stronger version of the
    // same regression than merely waiting for another card was.
    await page.getByTestId("sandbox-provider").selectOption("vercel");
    await expect(page.getByTestId("provider-needs-connection")).toBeVisible(
      LANDED,
    );
    await page.getByTestId("sandbox-provider").selectOption("docker");

    await page.getByTestId("concurrency-limit").fill("7");
    await page
      .getByTestId("egress-allowlist")
      .fill("api.example.com\n*.internal.dev");
    // Asserted before the save rather than only after the reload, so a field
    // reverted by a background load fails here — where the bug is — instead of
    // as a mismatch two steps later that reads like a persistence problem.
    await expect(page.getByTestId("concurrency-limit")).toHaveValue("7");
    await page.getByTestId("save-sandbox").click();
    await expect(page.getByTestId("sandbox-notice")).toBeVisible(LANDED);

    // A section is its own URL, so a reload comes back to it rather than to the
    // top of a nine-card page.
    await page.reload();
    await expect(page.getByTestId("concurrency-limit")).toHaveValue(
      "7",
      LANDED,
    );
    await expect(page.getByTestId("egress-allowlist")).toHaveValue(
      "api.example.com\n*.internal.dev",
    );
  });

  test("the sandbox form offers no value the server has not sent", async ({
    page,
  }) => {
    await signUp(page, "Patient Pat", uniqueEmail("patient"));

    // The form used to render before `project:settings-view` answered, seeded
    // with a concurrency of 3 and a blank provider as though the server had said
    // so — and an admin who pressed Save inside that window posted
    // `sandboxProvider: ""` with a limit of `Number("")`, which is `NaN`.
    //
    // Holding the response is the only way to observe that window. Asserting on
    // the settled page cannot tell a real 3 from an invented one, which is why
    // the `toHaveValue("3")` in the test above has always passed and would have
    // passed even if the request never fired.
    //
    // A gate rather than `times: 1` + a sleep: StrictMode double-invokes the
    // section's load effect, so delaying only the first request leaves the
    // second free to populate the form while we are still asserting the skeleton.
    // A fixed sleep is the same race on a slow assertion path. Releasing the
    // gate after the mid-flight checks — and never calling `unroute` while a
    // handler is awaiting it — is what keeps `route.continue()` from throwing
    // "Route is already handled!".
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/project/settings*", async (route) => {
      await held;
      await route.continue();
    });

    await openSection(page, "sandbox");
    // The card is there — only its contents are withheld, which is why
    // `SectionCard`'s `loading` replaces children rather than the card.
    await expect(page.getByTestId("sandbox-settings")).toBeVisible(LANDED);
    await expect(page.getByTestId("sandbox-skeleton")).toBeVisible();
    await expect(page.getByTestId("concurrency-limit")).toHaveCount(0);
    // …and the Save is present but disabled, so nothing can be posted from a
    // draft seeded out of nothing. Disabled rather than absent is the card's own
    // rule: the selector has to resolve in both states.
    await expect(page.getByTestId("save-sandbox")).toBeDisabled();

    release();

    // …and when the held response lands, the real value arrives in the form the
    // skeleton was standing in for.
    await expect(page.getByTestId("concurrency-limit")).toHaveValue(
      "3",
      LANDED,
    );
  });

  test("the provider's capabilities are reported by the server, not guessed", async ({
    page,
  }) => {
    await signUp(page, "Capable Kim", uniqueEmail("capable"));

    await openSection(page, "sandbox");
    const capabilities = page.getByTestId("provider-capabilities");
    await expect(capabilities).toBeVisible(LANDED);

    // docker is the default in development and cannot enforce an allowlist.
    await expect(capabilities).toContainText("no egress allowlist");

    await page.getByTestId("sandbox-provider").selectOption("vercel");
    await expect(capabilities).toContainText("live egress updates");

    // ...and so is *which account it needs*. A sandbox provider can require a
    // connection exactly as a context provider can, and `vercel` does — the microVM
    // is created in, and billed to, the project's own Vercel account. Selecting it
    // with nothing connected means no run will provision at all, so the warning
    // belongs where the choice is being made rather than only in `agent:validate`
    // after the admin has left. The kind comes off the server's provider catalog;
    // this page compares no provider name.
    await expect(page.getByTestId("provider-needs-connection")).toBeVisible();
    await expect(page.getByTestId("provider-needs-connection")).toContainText(
      "vercel",
    );

    // And the fix is in this card rather than a section away, which is what the
    // alert now says. The account form follows the *draft*, so it is here the
    // moment the provider is picked and before anything is saved.
    await expect(
      page.getByTestId("sandbox-settings").getByTestId("connection-vercel"),
    ).toBeVisible();
  });

  test("a sandbox account is connected where the provider is chosen", async ({
    page,
  }) => {
    // This form used to live among the git providers, one navigation away from the
    // dropdown that made it necessary — a warning and its fix on different pages.
    // It is still generated entirely from the server's description of the kind:
    // the GitHub section it grew out of hardcoded the kind, the label
    // "Installation id", and two environment variable names.
    await signUp(page, "Sandy Sandoval", uniqueEmail("sandbox-account"));

    await openSection(page, "sandbox");
    await expect(page.getByTestId("sandbox-settings")).toBeVisible(LANDED);

    // Nothing to connect for docker, which talks to a local daemon.
    await expect(page.getByTestId("connection-vercel")).toHaveCount(0);

    await page.getByTestId("sandbox-provider").selectOption("vercel");
    const vercel = page.getByTestId("connection-vercel");
    await expect(vercel).toBeVisible(LANDED);
    await expect(page.getByTestId("connection-unset-vercel")).toBeVisible();
    await expect(page.getByTestId("provider-needs-connection")).toBeVisible();
    // Catalog prose, not a frontend literal: where to mint the token has to
    // come from `connection:list` or this file is naming Vercel again.
    await expect(
      page.getByTestId("connection-secret-help-vercel"),
    ).toContainText("Account Settings → Tokens");

    // Both identifier fields are generated from the published metadata schema.
    await vercel.getByTestId("connection-vercel-teamId").fill("team_e2e");
    await vercel.getByTestId("connection-vercel-projectId").fill("prj_e2e");
    await page
      .getByTestId("connection-secret-vercel")
      .fill("vercel-token-9f31");

    // Asserted before the click for the reason the sandbox test above gives, and
    // this form has an extra way to fail silently: `connect` returns early when
    // the secret draft is empty, so a click that lands before React has taken the
    // fill posts *nothing* — and the assertion after it then waits ten seconds for
    // a badge that was never going to arrive. Reading the values back is what makes
    // that fail here, where the cause is, instead of there.
    await expect(page.getByTestId("connection-secret-vercel")).toHaveValue(
      "vercel-token-9f31",
    );
    await expect(vercel.getByTestId("connection-vercel-teamId")).toHaveValue(
      "team_e2e",
    );
    await page.getByTestId("connect-vercel").click();

    await expect(page.getByTestId("connection-ok-vercel")).toBeVisible(LANDED);
    // **The payoff of moving it here**, and untestable before without navigating
    // between two sections: the warning that says no run will provision goes away
    // because of something done in the same card.
    await expect(page.getByTestId("provider-needs-connection")).toHaveCount(0);
    // Write-only, exactly as the model section is: the last four and nothing more.
    await expect(vercel).toContainText("9f31");
    await expect(page.getByTestId("connection-secret-vercel")).toHaveValue("");
    // The identifiers *do* come back, because they are not secrets and an admin
    // re-connecting should not have to retype them.
    await expect(vercel.getByTestId("connection-vercel-teamId")).toHaveValue(
      "team_e2e",
    );

    // Whether an account can be checked against its third party is `probeable`
    // off the catalog, exactly as `secretShape` is — so Test appears here and not
    // on a kind with no probe, and `ConnectionForm` still names no provider.
    //
    // Deliberately **not** clicked, and that is the whole point: pressing it
    // makes a real outbound request, so a spec that clicked would be measuring
    // somebody else's uptime and error wording. `env.ts` points this backend's
    // Vercel origin at a dead port for the same reason, since the connect above
    // fires one automatically. What a browser can prove is that the control is
    // rendered from the server's answer; what the probe *says* is covered by
    // `connection-probe.test.ts` against a stub that misbehaves on demand.
    await expect(page.getByTestId("probe-vercel")).toBeVisible();

    // The connect above fired one automatically, and `env.ts` points this
    // backend's Vercel origin at a dead port — so a report lands here in
    // milliseconds without a byte leaving the machine. That it appears at all is
    // the auto-fire proven end to end.
    await expect(page.getByTestId("probe-result-vercel")).toBeVisible(LANDED);

    // **And it must not outlive the row it describes.** A report saying where
    // sandboxes will be created, still sitting under a disconnected account, is a
    // confident wrong answer about the one thing this feature exists to get
    // right. Two guards make it go: `useConnectionForms` forgets the state on
    // every connect and disconnect, and `ConnectionForm` renders the report only
    // beside a stored row.
    await page.getByTestId("disconnect-vercel").click();
    await expect(page.getByTestId("connection-unset-vercel")).toBeVisible(
      LANDED,
    );
    await expect(page.getByTestId("probe-result-vercel")).toHaveCount(0);
  });

  test("the provider's own options are a generated form too", async ({
    page,
  }) => {
    // `project:settings-edit` has always validated `sandboxConfig` against the
    // provider's schema; until that schema was published there was no field to
    // type one into. The enum and the bounds come from the registry, so nothing in
    // the frontend knows that a Vercel sandbox has a runtime.
    await signUp(page, "Config Cam", uniqueEmail("sandbox-config"));

    await openSection(page, "sandbox");
    await expect(page.getByTestId("sandbox-settings")).toBeVisible(LANDED);
    // Docker's one option, which is what proves the form is per provider rather
    // than a Vercel special case.
    await expect(page.getByTestId("sandbox-config-image")).toBeVisible();

    await page.getByTestId("sandbox-provider").selectOption("vercel");
    await expect(page.getByTestId("sandbox-config-egressMode")).toBeVisible();
    await page.getByTestId("sandbox-config-runtime").selectOption("node24");
    await page.getByTestId("sandbox-config-vcpus").fill("4");
    await expect(page.getByTestId("sandbox-config-vcpus")).toHaveValue("4");
    await page.getByTestId("save-sandbox").click();
    await expect(page.getByTestId("sandbox-notice")).toBeVisible(LANDED);

    await page.reload();
    await expect(page.getByTestId("sandbox-config-vcpus")).toHaveValue(
      "4",
      LANDED,
    );
    await expect(page.getByTestId("sandbox-config-runtime")).toHaveValue(
      "node24",
    );

    // Switching back must not 406 on `vcpus`, a key docker's strict schema has
    // never heard of and this form is no longer showing. The draft is per provider
    // kind for exactly that reason.
    await page.getByTestId("sandbox-provider").selectOption("docker");
    await page.getByTestId("save-sandbox").click();
    await expect(page.getByTestId("sandbox-notice")).toBeVisible(LANDED);
    await expect(page.getByTestId("sandbox-error")).toHaveCount(0);
  });

  test("a git provider account is generated from the server's own description", async ({
    page,
  }) => {
    await signUp(page, "Gitty Gina", uniqueEmail("git"));

    await openSection(page, "git-providers");
    await expect(page.getByTestId("connection-github")).toBeVisible(LANDED);

    // **Nothing is double-listed.** The kinds here are the ones the server filed
    // as `usage: "git"`, so the sandbox account is not among them — a
    // set-difference computed in the client is what would put it in both places.
    await expect(page.getByTestId("connection-vercel")).toHaveCount(0);

    // A GitHub installation stores no project secret — the App's PEM is
    // deployment config — so the form has identifiers and no credential box.
    await expect(page.getByTestId("connection-secret-github")).toHaveCount(0);
    await expect(
      page.getByTestId("connection-github").getByLabel(/installation/i),
    ).toBeVisible(LANDED);
  });

  test("a half-typed credential is guarded like any other unsaved edit", async ({
    page,
  }) => {
    // The regression for the rule that a section owns exactly **one** `markDirty`
    // effect. The Sandbox card holds two forms, and the shell's flag is keyed by
    // slug: an effect per form means one writing `false` discards the other's
    // input with no modal. Only the credential box is touched here, so this fails
    // the moment the settings draft's own effect is the last writer.
    await signUp(page, "Dirty Dana", uniqueEmail("dirty"));

    await openSection(page, "sandbox");
    await page.getByTestId("sandbox-provider").selectOption("vercel");
    await expect(page.getByTestId("connection-secret-vercel")).toBeVisible(
      LANDED,
    );
    // Saved first, so the settings draft is clean and the credential box is the
    // only thing holding anything. Without that this would pass on the provider
    // change alone and prove nothing about the second form.
    await page.getByTestId("save-sandbox").click();
    await expect(page.getByTestId("sandbox-notice")).toBeVisible(LANDED);

    await page.getByTestId("connection-secret-vercel").fill("half-typed");

    await page.getByTestId("section-model").click();
    await expect(page.getByTestId("discard-changes-modal")).toBeVisible(LANDED);
  });

  test("a connection is write-only: connected, then shown as four characters", async ({
    page,
  }) => {
    await signUp(page, "Connie Connor", uniqueEmail("connection"));

    await openSection(page, "model");
    await expect(page.getByTestId("settings-model")).toBeVisible(LANDED);

    // Both providers come from `connection:list`, which reads them off the
    // coding-agent registry — the frontend does not know that Claude Code
    // speaks Anthropic's wire format, the registry does.
    const anthropic = page.getByTestId("connection-anthropic");
    await expect(anthropic).toContainText("Claude Code");
    await expect(page.getByTestId("connection-openai")).toContainText("Codex");
    const authMode = page.getByTestId("connection-auth-mode-anthropic");
    await expect(authMode).toHaveValue("api_key");
    await expect(page.getByTestId("connection-auth-mode-openai")).toHaveCount(
      0,
    );

    // A new project has connected neither, and says so where an admin sees it.
    await expect(page.getByTestId("connection-unset-anthropic")).toBeVisible();

    await page
      .getByTestId("connection-value-anthropic")
      .fill("sk-ant-e2e-value-7b41");
    await page.getByTestId("connect-anthropic").click();

    await expect(anthropic).toContainText("7b41", LANDED);
    await expect(page.getByTestId("connection-unset-anthropic")).toBeHidden();

    // The value is nowhere in the rendered page, because no endpoint returns
    // it — the same card that just took it cannot show it back.
    await expect(page.locator("body")).not.toContainText("sk-ant-e2e-value");
    // ...and the field was cleared, so a stray Enter cannot resubmit it.
    await expect(page.getByTestId("connection-value-anthropic")).toHaveValue(
      "",
    );

    // The other provider is untouched by connecting this one.
    await expect(page.getByTestId("connection-unset-openai")).toBeVisible();

    // **The model key is the credential whose failure looks least like itself**,
    // because it never enters a sandbox: a revoked one reaches the reader as the
    // coding CLI's rendering of somebody else's 401, naming neither the account
    // nor which of the two credentials in that request was refused. Test asks the
    // provider here instead, and the connect above fired one automatically —
    // `env.ts` points both model origins at a dead port, so a report lands in
    // milliseconds with no byte leaving the machine.
    await expect(page.getByTestId("probe-anthropic")).toBeVisible();
    await expect(page.getByTestId("probe-result-anthropic")).toBeVisible(
      LANDED,
    );

    // Not clicked, deliberately, for the reason the Vercel spec gives at length:
    // a click makes a real outbound request in a deployment that has not
    // redirected the origin, and what the probe *says* is covered against a stub
    // that misbehaves on demand in `connection-probe-model.test.ts`.

    // Cursor's CLI talks a private surface no probe can pin a path to, so the
    // registry reports it unprobeable and no button appears. That the control is
    // driven by the server's answer rather than by a `kind ===` in the frontend
    // is the property worth asserting; a Test button that appeared everywhere
    // would report success for kinds it had never asked about.
    await expect(page.getByTestId("probe-cursor")).toHaveCount(0);

    await page.getByTestId("disconnect-anthropic").click();
    await expect(page.getByTestId("connection-unset-anthropic")).toBeVisible(
      LANDED,
    );
    // **And the report must not outlive the credential it describes.**
    await expect(page.getByTestId("probe-result-anthropic")).toHaveCount(0);

    // A subscription is the same write-only row with a different presentation
    // mode. The browser sends the mode; the server validates the oat shape.
    await authMode.selectOption("subscription");
    await expect(anthropic).toContainText("claude setup-token");
    await page
      .getByTestId("connection-value-anthropic")
      .fill("sk-ant-oat01-e2e-subscription-4e2f");
    await page.getByTestId("connect-anthropic").click();
    await expect(anthropic).toContainText("4e2f", LANDED);
    await expect(authMode).toHaveValue("subscription");
  });

  test("there is no general secrets table, which is the point", async ({
    page,
  }) => {
    // A table of named values was a table an agent's configuration could
    // reference *by name*, and a name in a config became a variable in a
    // sandbox. Its absence is a feature, so it is asserted rather than assumed.
    await signUp(page, "Nora Names", uniqueEmail("no-secrets"));

    await openSection(page, "model");
    await expect(page.getByTestId("settings-model")).toBeVisible(LANDED);

    await expect(page.getByTestId("secrets-card")).toHaveCount(0);
    await expect(page.getByTestId("secrets-table")).toHaveCount(0);
    await expect(page.getByTestId("secret-name")).toHaveCount(0);
  });

  test("connecting a credential is audited without the value", async ({
    page,
  }) => {
    await signUp(page, "Audit Ada", uniqueEmail("connection-audit"));

    await openSection(page, "model");
    await expect(page.getByTestId("settings-model")).toBeVisible(LANDED);
    await page
      .getByTestId("connection-value-openai")
      .fill("sk-openai-e2e-value-3c9d");
    await page.getByTestId("connect-openai").click();
    await expect(page.getByTestId("connection-openai")).toContainText(
      "3c9d",
      LANDED,
    );

    await page.getByTestId("project-menu").getByRole("button").click();
    await page.getByTestId("audit-link").click();
    const table = page.getByTestId("audit-table");
    await expect(table).toBeVisible(LANDED);
    await expect(table).toContainText("connection:put");
    await expect(table).toContainText("openai");

    // The two layers that keep the value out: `secretValue` is on
    // SENSITIVE_KEYS so it never reaches `metadata`, and `after` is serializer
    // output, which has no field it could occupy.
    const row = table.locator("tr", { hasText: "connection:put" }).first();
    await row.getByRole("button", { name: "details" }).click();
    await expect(page.getByTestId("audit-diff")).toContainText("3c9d");
    await expect(page.locator("body")).not.toContainText("sk-openai-e2e-value");
  });

  test("the sandbox ledger renders, empty, before anything has run", async ({
    page,
  }) => {
    await signUp(page, "Ledger Lee", uniqueEmail("ledger"));

    await openSection(page, "ledger");
    await expect(page.getByTestId("sandbox-ledger")).toBeVisible(LANDED);
    await expect(page.getByTestId("sandbox-table")).toContainText(
      "No sandboxes yet",
    );
  });

  test("renaming the project moves the navbar's switcher with it", async ({
    page,
  }) => {
    // The only thing that catches a dropped `refresh()`: the switcher reads
    // `AuthContext`, not this page, so a rename that skips it succeeds everywhere
    // except the one place the user is looking.
    await signUp(page, "Rena Namer", uniqueEmail("rename"));

    await expect(page.getByTestId("project-name")).toBeVisible(LANDED);
    await page.getByTestId("project-name").fill("Renamed by e2e");
    await page.getByTestId("save-general").click();
    await expect(page.getByTestId("general-notice")).toBeVisible(LANDED);

    await expect(page.getByTestId("project-switcher-toggle")).toHaveText(
      "Renamed by e2e",
      LANDED,
    );
  });

  test("leaving a section with unsaved edits asks first", async ({ page }) => {
    // The unsaved-changes guard's first coverage anywhere. It is shared with the
    // agent editor, so this protects both — and it is the one case the sidebar can
    // actually see, since browser Back needs a data router this app does not use.
    await signUp(page, "Dirty Dora", uniqueEmail("dirty"));

    await expect(page.getByTestId("project-name")).toBeVisible(LANDED);
    await page.getByTestId("project-name").fill("Half-typed name");
    await expect(page.getByTestId("section-dirty")).toBeVisible();

    await page.getByTestId("section-members").click();
    await expect(page.getByTestId("discard-changes-modal")).toBeVisible();

    // Staying keeps both the URL and the draft.
    await page.getByTestId("discard-cancel").click();
    await expect(page).toHaveURL(/\/settings\/general$/);
    await expect(page.getByTestId("project-name")).toHaveValue(
      "Half-typed name",
    );

    await page.getByTestId("section-members").click();
    await page.getByTestId("discard-confirm").click();
    await expect(page).toHaveURL(/\/settings\/members$/, LANDED);
    await expect(page.getByTestId("members-table")).toBeVisible(LANDED);

    // ...and the draft is gone, rather than waiting to be posted by the next save.
    await page.getByTestId("section-general").click();
    await expect(page.getByTestId("project-name")).not.toHaveValue(
      "Half-typed name",
      LANDED,
    );
  });

  test("the narrow disclosure closes even when the guard answers first", async ({
    page,
  }) => {
    // On a phone the section list is a disclosure over the section, not a sidebar
    // beside it, so leaving it open hides the thing the reader just chose. It used
    // to close only on the *immediate* path: an intercepted click showed the modal
    // and skipped the close, and the navigation the modal performed afterwards was
    // nothing the list was watching. So the guard — the one case where a reader is
    // most likely to lose their place — was the one case it stayed open.
    await signUp(page, "Narrow Nadia", uniqueEmail("narrow"));
    await page.setViewportSize({ width: 390, height: 844 });

    const list = page.locator(".tx-sidenav");
    const toggle = page.getByTestId("section-nav-toggle");

    await expect(page.getByTestId("project-name")).toBeVisible(LANDED);
    await page.getByTestId("project-name").fill("Half-typed name");

    // The dirty marker is *inside* the list, so a closed disclosure is also the
    // only place it cannot be read — one more reason this path is worth a test.
    await toggle.click();
    await expect(list).toBeVisible();
    await expect(page.getByTestId("section-dirty")).toBeVisible();

    await page.getByTestId("section-members").click();
    await expect(page.getByTestId("discard-changes-modal")).toBeVisible();
    await page.getByTestId("discard-confirm").click();

    await expect(page).toHaveURL(/\/settings\/members$/, LANDED);
    await expect(page.getByTestId("members-table")).toBeVisible(LANDED);
    await expect(list).toBeHidden();
    await expect(toggle).toHaveText("Members");
  });
});
