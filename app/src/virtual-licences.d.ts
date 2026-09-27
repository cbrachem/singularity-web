/**
 * The module `app/scripts/licences-plugin.ts` builds while the bundle is. It exists only at
 * build time, so this is where the type system learns what it is.
 *
 * The shape arrives as an `import()` type rather than as an import statement: a relative
 * specifier inside an ambient module declaration is resolved against the module *name*, not
 * against this file, so an `import … from "./ui/…"` here would quietly be `any` —
 * `skipLibCheck` swallows the error it makes, and every use of the document loses its type.
 */
declare module "virtual:licences" {
  const licences: import("./ui/licences/document.ts").LicenceDocument;
  export default licences;
}
