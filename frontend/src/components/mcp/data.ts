import type { ApprovalList } from "@backend/actions/approval/approval-list";
import type { ApprovalView } from "@backend/actions/approval/approval-view";
import type { BotMcpServerList } from "@backend/actions/bot-mcp-server/bot-mcp-server-list";
import type { McpServerList } from "@backend/actions/mcp-server/mcp-server-list";
import type { McpServerMatchTools } from "@backend/actions/mcp-server/mcp-server-match-tools";
import type { McpServerView } from "@backend/actions/mcp-server/mcp-server-view";
import type { ActionResponse } from "keryx";

/** A project's MCP server as `mcp-server:list` serializes it — never with a credential. */
export type McpServer = ActionResponse<McpServerList>["mcpServers"][number];

/** `mcp-server:view`'s answer: the server and its cached catalog. */
export type McpServerDetail = ActionResponse<McpServerView>;

/** One tool of a server's catalog, named `server/tool`. */
export type CatalogTool = McpServerDetail["tools"][number];

/** `mcp-server:match-tools`' answer. */
export type MatchResult = ActionResponse<McpServerMatchTools>;

/** `bot-mcp-server:list`'s answer: the bindings and the capabilities text. */
export type BotMcpServers = ActionResponse<BotMcpServerList>;

/** One server a bot has, with its patterns and read-only setting. */
export type BotMcpServer = BotMcpServers["botMcpServers"][number];

/** One row of `approval:list`. */
export type ApprovalRow = ActionResponse<ApprovalList>["approvals"][number];

/** `approval:view`'s approval, with who asked and who decided. */
export type ApprovalDetail = ActionResponse<ApprovalView>["approval"];
