/**
 * Web API methods Hypotenuse calls that the pinned OpenAPI spec
 * (`web-api.json`, from `slackapi/slack-api-specs`) predates. Each is
 * described from its documentation page, cited beside it, in the same shape
 * the fetch script writes: whether a token is required, and each parameter's
 * type and whether it is required. When Slack publishes them in a spec, the
 * fetch script takes them over and these entries go.
 */
export const SUPPLEMENT: Record<
  string,
  {
    doc: string;
    token: boolean;
    params: Record<string, { type: string; required: boolean }>;
  }
> = {
  "assistant.threads.setStatus": {
    doc: "https://docs.slack.dev/reference/methods/assistant.threads.setStatus",
    token: true,
    params: {
      channel_id: { type: "string", required: true },
      thread_ts: { type: "string", required: true },
      status: { type: "string", required: true },
      loading_messages: { type: "array", required: false },
    },
  },
  "chat.startStream": {
    doc: "https://docs.slack.dev/reference/methods/chat.startStream",
    token: true,
    params: {
      channel: { type: "string", required: true },
      thread_ts: { type: "string", required: true },
      markdown_text: { type: "string", required: false },
      recipient_team_id: { type: "string", required: false },
      recipient_user_id: { type: "string", required: false },
    },
  },
  "chat.appendStream": {
    doc: "https://docs.slack.dev/reference/methods/chat.appendStream",
    token: true,
    params: {
      channel: { type: "string", required: true },
      ts: { type: "string", required: true },
      markdown_text: { type: "string", required: true },
    },
  },
  "chat.stopStream": {
    doc: "https://docs.slack.dev/reference/methods/chat.stopStream",
    token: true,
    params: {
      channel: { type: "string", required: true },
      ts: { type: "string", required: true },
      markdown_text: { type: "string", required: false },
      blocks: { type: "string", required: false },
      metadata: { type: "string", required: false },
    },
  },
  "apps.manifest.create": {
    doc: "https://docs.slack.dev/reference/methods/apps.manifest.create",
    token: true,
    params: {
      manifest: { type: "string", required: true },
    },
  },
};
