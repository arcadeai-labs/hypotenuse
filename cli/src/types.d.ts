/** A file imported `with { type: "text" }` is its text. */
declare module "*.toml" {
  const text: string;
  export default text;
}

/** A unit-file template imported `with { type: "text" }`. */
declare module "*.service" {
  const text: string;
  export default text;
}

/** A plist template imported `with { type: "text" }`. */
declare module "*.plist" {
  const text: string;
  export default text;
}

/** A role's built-in prompt template imported `with { type: "text" }`. */
declare module "*.md" {
  const text: string;
  export default text;
}
