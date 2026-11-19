# Vendored libraries

`supabase-js.umd.js` is `@supabase/supabase-js` **2.118.0** (MIT), the file `dist/umd/supabase.js` from the npm package.
Tarball integrity checked against the npm registry: `sha512-FxI8UXMVC2UG7IkeiI8fuQZqq2oI3JeSuN8MPIC2RLVaoEAxKS0nqE6kii9Ewpq8f9gNPM6git1Y8f0vN/QLFw==`

It is committed so the hosted app does not depend on a CDN at run time. To upgrade: `npm pack @supabase/supabase-js@<version>`,
copy `package/dist/umd/supabase.js` here, update this file, and test login and upload.

## editorjs/ (block editor for journal entries)

All from npm, MIT unless noted, each tarball's integrity checked against the registry. Versions are the official `latest` tag of each package, all more than 8 weeks old when added (13 Nov 2026).
The files are the `dist/*.umd.js` builds, loaded by `web/index.html` as globals.

| file | package | version | global |
|---|---|---|---|
| editorjs.umd.js | @editorjs/editorjs (Apache-2.0) | 2.31.7 | EditorJS |
| header.umd.js | @editorjs/header | 2.8.9 | Header |
| list.umd.js | @editorjs/list | 2.0.9 | EditorjsList |
| checklist.umd.js | @editorjs/checklist | 1.6.0 | Checklist |
| quote.umd.js | @editorjs/quote | 2.7.6 | Quote |
| delimiter.umd.js | @editorjs/delimiter | 1.4.2 | Delimiter |
| image.umd.js | @editorjs/image | 2.10.3 | ImageTool |
| code.umd.js | @editorjs/code | 2.9.4 | CodeTool |
| inline-code.umd.js | @editorjs/inline-code | 1.5.2 | InlineCode |
| marker.umd.js | @editorjs/marker | 1.4.0 | Marker |
| table.umd.js | @editorjs/table | 2.4.6 | Table |

Not used on purpose: npm shows an odd `@editorjs/editorjs@0.0.0` and `@editorjs/header@3.0.0` that are not the `latest` tag.
To upgrade a file: `npm pack <pkg>@<version>`, verify `dist.integrity`, copy `package/dist/*.umd.js`, update this table, retest the entry editor.
