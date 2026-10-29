CREATE TABLE "cli_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"device" varchar(256) NOT NULL,
	"token_hash" text NOT NULL,
	"last_four" varchar(4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "cli_tokens" ADD CONSTRAINT "cli_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cli_tokens_token_hash_idx" ON "cli_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "cli_tokens_user_idx" ON "cli_tokens" USING btree ("user_id");