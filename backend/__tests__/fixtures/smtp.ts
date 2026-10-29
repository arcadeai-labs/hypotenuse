import type { Socket, TCPSocketListener } from "bun";

/** One message the fake server accepted. */
export interface ReceivedMail {
  from: string;
  to: string[];
  /** The raw DATA section: headers, a blank line, then the body. */
  data: string;
  /** The `Subject:` header, decoded from the raw data. */
  subject: string;
}

/** A running fake SMTP server. */
export interface FakeSmtpServer {
  port: number;
  /** Every message accepted so far. */
  received: ReceivedMail[];
  /** While true, every `MAIL FROM` is refused with a transient `451`. */
  failing: boolean;
  stop(): void;
}

/** Per-connection protocol state. */
interface SessionState {
  buffer: string;
  inData: boolean;
  from: string;
  to: string[];
  data: string[];
}

/**
 * Start an SMTP server on a free loopback port that speaks just enough of RFC
 * 5321 for nodemailer: greeting, `EHLO`/`HELO`, `MAIL FROM`, `RCPT TO`, `DATA`,
 * `RSET`, `NOOP`, `QUIT`. No TLS and no auth are advertised, so a client never
 * upgrades. The mail server is not ours, so it is faked in process over its real
 * wire protocol — the real nodemailer transport runs against it.
 * @returns The server, with what it received.
 */
export function startFakeSmtpServer(): FakeSmtpServer {
  const server: FakeSmtpServer = {
    port: 0,
    received: [],
    failing: false,
    stop: () => listener.stop(true),
  };

  const reply = (socket: Socket<SessionState>, line: string) => {
    socket.write(`${line}\r\n`);
  };

  /**
   * Answer one command line.
   * @param socket - The client.
   * @param line - The line, without its CRLF.
   */
  const command = (socket: Socket<SessionState>, line: string) => {
    const state = socket.data;
    if (state.inData) {
      if (line === ".") {
        state.inData = false;
        const data = state.data.join("\r\n");
        const subject = /^Subject: (.*)$/im.exec(data)?.[1]?.trim() ?? "";
        server.received.push({ from: state.from, to: state.to, data, subject });
        state.data = [];
        state.to = [];
        reply(socket, "250 2.0.0 queued");
      } else {
        // Dot-stuffing: a leading `..` stands for a literal `.`.
        state.data.push(line.startsWith("..") ? line.slice(1) : line);
      }
      return;
    }

    const verb = line.slice(0, 4).toUpperCase();
    if (verb === "EHLO" || verb === "HELO") {
      reply(socket, "250-fake.smtp.test");
      reply(socket, "250 8BITMIME");
    } else if (line.toUpperCase().startsWith("MAIL FROM:")) {
      if (server.failing) {
        reply(socket, "451 4.3.0 mail server down");
        return;
      }
      state.from = line
        .slice(10)
        .trim()
        .replace(/^<|>.*$/g, "");
      reply(socket, "250 2.1.0 ok");
    } else if (line.toUpperCase().startsWith("RCPT TO:")) {
      state.to.push(
        line
          .slice(8)
          .trim()
          .replace(/^<|>.*$/g, ""),
      );
      reply(socket, "250 2.1.5 ok");
    } else if (verb === "DATA") {
      state.inData = true;
      reply(socket, "354 end data with <CR><LF>.<CR><LF>");
    } else if (verb === "RSET") {
      state.to = [];
      state.data = [];
      reply(socket, "250 2.0.0 ok");
    } else if (verb === "NOOP") {
      reply(socket, "250 2.0.0 ok");
    } else if (verb === "QUIT") {
      reply(socket, "221 2.0.0 bye");
      socket.end();
    } else {
      reply(socket, "502 5.5.2 command not implemented");
    }
  };

  const listener: TCPSocketListener<SessionState> = Bun.listen<SessionState>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buffer: "", inData: false, from: "", to: [], data: [] };
        reply(socket, "220 fake.smtp.test ESMTP");
      },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
        let index = socket.data.buffer.indexOf("\r\n");
        while (index !== -1) {
          const line = socket.data.buffer.slice(0, index);
          socket.data.buffer = socket.data.buffer.slice(index + 2);
          command(socket, line);
          index = socket.data.buffer.indexOf("\r\n");
        }
      },
    },
  });
  server.port = listener.port;
  return server;
}
