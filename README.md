[JSON Schema](https://json-schema.org/) for
[ESTree](https://github.com/estree/estree)-compatible Typescript AST generated
from
[@typescript-eslint/types](https://www.npmjs.com/package/@typescript-eslint/types).

Notably omitted from the schema is `RegExpLiteral`s and `BigIntLiteral`s because
there is no JSON Schema representation for `RegExp` or `BigInt` as well as
`NodeOrTokenData` because source code is unlikely to be available.

Please make a pull request with necessary changes if either of the above
observations change.

## Example

```json
{
  "$schema": "https://raw.githubusercontent.com/ssttevee/tstree-json-schema/v5.41.0/ast-spec.json",
  "type": "Program",
  "body": [
    {
      "type": "ExpressionStatement",
      "expression": {
        "type": "CallExpression",
        "optional": false,
        "callee": {
          "type": "MemberExpression",
          "optional": false,
          "computed": false,
          "object": {
            "type": "Identifier",
            "name": "console"
          },
          "property": {
            "type": "Identifier",
            "name": "log"
          }
        },
        "arguments": [
          {
            "type": "Literal",
            "value": "hello world"
          }
        ]
      }
    }
  ]
}
```
