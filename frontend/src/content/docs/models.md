# Models

A bot thinks with a language model from a provider you pay. Hypotenuse does not resell models: a project connects
its own provider accounts with its own API keys, then gives the models it wants to use short **names** that bots
choose from. Both live under **Settings → Models**. Every member can read them; only the project's admins change them.

![Settings → Models: a connection and the project's model names](illustration:models)

## Connections

A **connection** is one provider account: a provider, the API key that pays for it, and — for some providers — the
address it answers at.

| Provider | Base URL |
|---|---|
| Anthropic | optional; the provider's own by default |
| OpenAI | optional; the provider's own by default |
| Vercel AI Gateway | optional; one key reaches models from many providers |
| OpenAI-compatible | **required**: any server that speaks OpenAI's API, such as a self-hosted model or another vendor's endpoint |

Add one with a name you will recognise (`Anthropic (production)`), the provider, and the key.

### Keys

- A key is **encrypted** before it is stored, and it is **never shown again** — not to admins, not in the CLI, not in
  the [audit log](/docs/audit). A connection shows only the key's last four characters, so you can tell which key
  it holds.
- To change a key, use **Rotate key** and paste the new one. The old one is replaced, not kept.
- Hypotenuse calls a provider only from its own servers. A key never reaches a browser, a bot's tools, or a sandbox.
- A base URL must be a public `https` address; Hypotenuse refuses one that points into a private network.

### Testing a key

**Test** asks the provider whether the key works, and the connection shows the answer:

| Glyph | Means |
|---|---|
| dotted ring | Not tested yet, or the key or address changed since the last test |
| disc with a check | The key worked |
| disc with a cross | The last test failed; the reason the provider gave is shown under the connection |

A failed test changes nothing else: fix the key or the address and test again.

## Model names

A bot never names a model directly. It names one of the project's **model names** — `default`, `fast`, or any name
you add — and each name points at one model through one connection. That indirection is the point: when a better
model ships, an admin points `default` at it once, and every bot that uses `default` moves with no bot edited. The
same goes for moving from one provider account to another.

Every project needs two names before **any** bot can run:

| Name | What a bot uses it for |
|---|---|
| `default` | its main model: reading, deciding, and answering |
| `fast` | quick, cheap calls: summaries, titles, routing |

Until both exist, they are listed under **Model names** as rows to set, and the Bots page says so. They cannot be
renamed. Add more names for other jobs — `reasoning` for a slower, stronger model, say — and choose them on a bot's
page.

When you set a name, the model field offers the models the connection's provider lists. A provider that does not
list them lets you type the model's id instead, and you can always type an id the list does not have yet.

A name can also carry a **temperature** (0 to 2) and an **output limit** in tokens, applied to every call made
through it. A bot that needs different settings uses a different name.

## Deleting

- **A connection** cannot be deleted while a model name uses it; the refusal names which. Point those names at
  another connection first. Deleting a connection erases its key.
- **A model name** cannot be deleted while a bot uses it; the refusal names the bots. Choose another name on those
  bots first. Deleting `default` or `fast` is allowed when nothing uses it, and no bot can run until it is set again.
