import type { JSONSchema4 } from "json-schema";
import fs from "fs/promises";
import ts from "typescript";

(async () => {
  const file = ts.createSourceFile(
    "ast-spec.ts",
    await (await fetch(
      "https://unpkg.com/@typescript-eslint/types@5.41.0/dist/generated/ast-spec.d.ts",
    )).text(),
    ts.ScriptTarget.ESNext,
  );

  type Declaration =
    | ts.InterfaceDeclaration
    | ts.EnumDeclaration
    | ts.TypeAliasDeclaration;

  const declarations: Record<string, Declaration> = {};
  for (const statement of file.statements) {
    if (
      !ts.isInterfaceDeclaration(statement) &&
      !ts.isEnumDeclaration(statement) &&
      !ts.isTypeAliasDeclaration(statement)
    ) {
      continue;
    }

    declarations[statement.name.getText(file)] = statement;
  }

  function valueOf(decl: ts.InterfaceDeclaration): string[] {
    return Array.from(
      new Set(
        (decl.parent && ts.isInterfaceDeclaration(decl.parent)
          ? valueOf(decl.parent)
          : [])
          .concat(
            decl.members
              .filter(ts.isPropertySignature)
              .flatMap((member) => member.type ? [member.type] : [])
              .filter(ts.isLiteralTypeNode)
              .map((type) => type.literal)
              .filter((t): t is ts.StringLiteral => ts.isStringLiteral(t))
              .map((str) => str.text),
          ),
      ),
    );
  }

  const definitions: Record<string, JSONSchema4> = {};

  const requestedTypes: string[] = [
    "Program",
    "BaseNode",
    "BaseToken",
    "PunctuatorTokenToText",
  ];
  function requestType(name: string, requester: string) {
    // console.log(name, "requested by", requester);

    if (
      !(name in definitions) && !requestedTypes.includes(name)
    ) {
      requestedTypes.push(name);
    }

    return {
      "$ref": "#/definitions/" + name,
    };
  }

  function declToDef(
    declName: string,
    type: ts.TypeNode | ts.InterfaceDeclaration,
  ): JSONSchema4 {
    if (ts.isArrayTypeNode(type)) {
      return {
        type: "array",
        items: declToDef(declName, type.elementType),
      };
    }

    if (ts.isUnionTypeNode(type)) {
      return {
        oneOf: type.types.flatMap((type) => {
          switch (type.getText(file)) {
            case "RegExp":
            case "RegExpLiteral":
            case "BigIntLiteral":
              return [];
          }

          return [declToDef(declName, type)];
        }),
      };
    }

    if (ts.isLiteralTypeNode(type)) {
      if (type.literal.kind === ts.SyntaxKind.NullKeyword) {
        return { type: "null" };
      }

      if (type.literal.kind === ts.SyntaxKind.TrueKeyword) {
        return { type: "boolean", enum: [true] };
      }

      if (type.literal.kind === ts.SyntaxKind.FalseKeyword) {
        return { type: "boolean", enum: [false] };
      }

      if (ts.isStringLiteral(type.literal)) {
        return { type: "string", enum: [type.literal.text] };
      }

      if (ts.isNumericLiteral(type.literal)) {
        return { type: "number", enum: [type.literal.text] };
      }

      throw new Error(
        `unexpected literal type: ${ts.SyntaxKind[type.literal.kind]} (${type.literal.getText(file)
        })`,
      );
    }

    if (ts.isExpressionWithTypeArguments(type)) {
      if (!type.typeArguments) {
        return requestType(type.getText(file), declName);
      }
    }

    if (ts.isTypeReferenceNode(type)) {
      if (ts.isQualifiedName(type.typeName)) {
        const ns = type.typeName.left.getText(file);
        if (ns !== "AST_NODE_TYPES" && ns !== "AST_TOKEN_TYPES") {
          throw new Error(
            "unexpected type " + type.typeName.getText(file),
          );
        }

        return {
          type: "string",
          enum: [type.typeName.right.getText(file)],
        };
      }

      const name = type.typeName.getText(file);
      if (name === "ValueOf") {
        if (type.typeArguments?.length === 1) {
          const typeArgName = type.typeArguments[0].getText(file);
          const decl = declarations[typeArgName];
          if (!decl) {
            throw new Error(`unknown type ValueOf<${typeArgName}>`);
          }

          if (ts.isInterfaceDeclaration(decl)) {
            return {
              type: "string",
              enum: valueOf(decl),
            };
          }

          throw new Error(`unexpected type ValueOf<${typeArgName}>`);
        }

        throw new Error("ValueOf missing or too many type arguments");
      }

      return requestType(name, declName);
    }

    if (ts.isTypeLiteralNode(type) || ts.isInterfaceDeclaration(type)) {
      const members = type.members.map(
        (member): [name: string, def: JSONSchema4, required: boolean] => {
          if (!ts.isPropertySignature(member)) {
            throw new Error("unexpected member type");
          }

          if (!member.type) {
            throw new Error("no type");
          }

          let name = member.name.getText(file);
          if (name.startsWith("[")) {
            if (name.startsWith("[SyntaxKind.")) {
              name = name.slice(12, -1);
            } else {
              throw new Error("unexpected computed property name");
            }
          }

          return [name, declToDef(declName, member.type), !member.questionToken];
        },
      );

      const obj: JSONSchema4 = {
        type: "object",
        properties: Object.fromEntries(members.map(([name, def]) => [name, def])),
        required: members.filter(([, , required]) => required).flatMap(([name]) =>
          name
        ),
      };

      if (!ts.isInterfaceDeclaration(type)) {
        return obj;
      }

      const inheritedTypes = type.heritageClauses?.flatMap((hc) => hc.types)
        ?.filter((t) => {
          switch (t.getText(file)) {
            case "NodeOrTokenData":
            case "BaseNode":
            case "BaseToken":
              return false;
          }

          return true;
        });
      if (!inheritedTypes?.length) {
        return obj;
      }

      return {
        allOf: [
          ...(inheritedTypes.map((t) => declToDef(declName, t))),
          obj,
        ],
      };
    }

    if (ts.isParenthesizedTypeNode(type)) {
      return declToDef(declName, type.type);
    }

    switch (type.kind) {
      case ts.SyntaxKind.StringKeyword:
        return { type: "string" };

      case ts.SyntaxKind.NumberKeyword:
      case ts.SyntaxKind.BigIntKeyword:
        return { type: "number" };

      case ts.SyntaxKind.BooleanKeyword:
        return { type: "boolean" };

      case ts.SyntaxKind.AnyKeyword:
      case ts.SyntaxKind.UnknownKeyword:
        // case ts.SyntaxKind.ThisKeyword:
        return { type: "any" };

      // case ts.SyntaxKind.VoidKeyword:

      case ts.SyntaxKind.NullKeyword:
      case ts.SyntaxKind.UndefinedKeyword:
        // case ts.SyntaxKind.NeverKeyword:
        return { type: "null" };

      // case ts.SyntaxKind.ObjectKeyword:
      //   return { type: "object", additionalProperties: true };
    }

    // switch (name) {
    //   case "string":
    //     return { type: "string" };
    // }

    console.log(declName, type.kind, ts.SyntaxKind[type.kind]);

    return { "$ref": "#/definitions/" + type.getText(file) };
  }

  while (requestedTypes.length) {
    const requestedType = requestedTypes.pop()!;
    const decl = declarations[requestedType];
    if (!decl) {
      console.log("missing declaration for", requestedType);
      continue;
    }

    if (ts.isInterfaceDeclaration(decl)) {
      definitions[requestedType] = declToDef(requestedType, decl);
      continue;
    }

    if (ts.isTypeAliasDeclaration(decl)) {
      definitions[requestedType] = declToDef(requestedType, decl.type);
      continue;
    }

    if (ts.isEnumDeclaration(decl)) {
      definitions[requestedType] = {
        type: "string",
        enum: decl.members.map((member) => member.name.getText(file)),
      };
      continue;
    }

    console.log(decl);
    throw new Error(
      "unexpected decl type " + ts.SyntaxKind[(decl as any).kind] + " for " +
      requestedType,
    );
  }

  const program = definitions.Program;
  delete definitions.Program;

  await fs.writeFile(
    "ast-spec.json",
    JSON.stringify(
      {
        "$schema": "http://json-schema.org/schema#",
        definitions: Object.fromEntries(
          Object.entries(definitions).sort(([a], [b]) => a.localeCompare(b)),
        ),
        ...program,
      },
      null,
      2,
    ),
  );

  console.log("done");
})();
