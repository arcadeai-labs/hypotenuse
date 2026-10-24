CREATE TABLE "cost_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"agent_session_id" integer NOT NULL,
	"root_agent_session_id" integer NOT NULL,
	"work_item_id" integer NOT NULL,
	"kind" text NOT NULL,
	"role" text,
	"repository" text,
	"external_issue_id" text,
	"issue_identifier" text,
	"runner_id" integer,
	"runner_name" text NOT NULL,
	"runner_user_id" integer,
	"issuer_user_id" integer,
	"agent_id" text,
	"ending" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(14, 6),
	"claimed_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cost_records_claim_idx" ON "cost_records" USING btree ("work_item_id","claimed_at");--> statement-breakpoint
CREATE INDEX "cost_records_project_ended_idx" ON "cost_records" USING btree ("project_id","ended_at");--> statement-breakpoint
CREATE INDEX "cost_records_session_idx" ON "cost_records" USING btree ("agent_session_id");--> statement-breakpoint
CREATE INDEX "cost_records_root_idx" ON "cost_records" USING btree ("root_agent_session_id");