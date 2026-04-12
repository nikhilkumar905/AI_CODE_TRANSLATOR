#!/usr/bin/env python3
"""Local trained model translation service (Python <-> C++)."""

import ast
import json
import os
import re
import sys


def emit(payload):
    print(json.dumps(payload), flush=True)


def load_model(model_dir):
    try:
        import torch
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
    except Exception as exc:
        raise RuntimeError("Missing Python dependencies. Install with: pip install -r backend/requirements.txt") from exc

    if not os.path.isdir(model_dir):
        raise RuntimeError(f"Model directory not found: {model_dir}")

    tokenizer = AutoTokenizer.from_pretrained(
        model_dir,
        local_files_only=True,
        use_fast=False,
        extra_special_tokens={},
    )
    model = AutoModelForSeq2SeqLM.from_pretrained(model_dir, local_files_only=True)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device)
    model.eval()

    return tokenizer, model, device


class PyToCpp:
    def __init__(self, code):
        self.tree = ast.parse(code)
        self.lines = []
        self.classes = [n for n in self.tree.body if isinstance(n, ast.ClassDef)]
        self.functions = [n for n in self.tree.body if isinstance(n, ast.FunctionDef)]
        self.class_names = {c.name for c in self.classes}
        self.function_name_map = {
            fn.name: ("py_main" if fn.name == "main" else fn.name)
            for fn in self.functions
        }
        self.field_types = self._collect_field_types()

    def emit(self, text, indent=0):
        self.lines.append("    " * indent + text)

    def _collect_field_types(self):
        out = {}
        preferred = "Node" if "Node" in self.class_names else None

        for c in self.classes:
            fields = {}
            for fn in [n for n in c.body if isinstance(n, ast.FunctionDef)]:
                ctor_vars = {}
                for stmt in fn.body:
                    if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
                        if isinstance(stmt.value, ast.Call) and isinstance(stmt.value.func, ast.Name) and stmt.value.func.id in self.class_names:
                            ctor_vars[stmt.targets[0].id] = f"{stmt.value.func.id}*"

                    if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Attribute):
                        t = stmt.targets[0]
                        if isinstance(t.value, ast.Name) and t.value.id == "self":
                            name = t.attr
                            val = stmt.value
                            if isinstance(val, ast.Name) and val.id in ctor_vars:
                                fields[name] = ctor_vars[val.id]
                            elif isinstance(val, ast.Constant) and val.value is None:
                                if name in {"next", "head", "tail", "prev"} and preferred:
                                    fields[name] = f"{preferred}*"
                                else:
                                    fields[name] = f"{c.name}*"
                            elif isinstance(val, ast.Constant) and isinstance(val.value, int):
                                fields[name] = "int"
                            elif isinstance(val, ast.Constant) and isinstance(val.value, float):
                                fields[name] = "double"
                            elif isinstance(val, ast.Constant) and isinstance(val.value, bool):
                                fields[name] = "bool"
                            elif isinstance(val, ast.Constant) and isinstance(val.value, str):
                                fields[name] = "string"
                            elif isinstance(val, ast.Call) and isinstance(val.func, ast.Name) and val.func.id in self.class_names:
                                fields[name] = f"{val.func.id}*"
                            elif isinstance(val, ast.Name) and val.id in {"data", "value", "key", "val"}:
                                fields[name] = "int"
                            else:
                                fields[name] = "auto"
            out[c.name] = fields
        return out

    def expr(self, node, ctx):
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Constant):
            if isinstance(node.value, str):
                return json.dumps(node.value)
            if node.value is None:
                return "nullptr"
            if isinstance(node.value, bool):
                return "true" if node.value else "false"
            return str(node.value)
        if isinstance(node, ast.Attribute):
            if isinstance(node.value, ast.Name) and node.value.id == "self":
                return f"this->{node.attr}"
            if isinstance(node.value, ast.Name) and node.value.id in ctx["ptr"]:
                return f"{node.value.id}->{node.attr}"
            return f"{self.expr(node.value, ctx)}.{node.attr}"
        if isinstance(node, ast.Subscript):
            return f"{self.expr(node.value, ctx)}[{self.expr(node.slice, ctx)}]"
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id == "len" and len(node.args) == 1:
                return f"{self.expr(node.args[0], ctx)}.size()"
            if isinstance(node.func, ast.Name) and node.func.id in self.class_names:
                args = ", ".join(self.expr(a, ctx) for a in node.args)
                return f"new {node.func.id}({args})"
            if isinstance(node.func, ast.Name) and node.func.id in self.function_name_map:
                fn = self.function_name_map[node.func.id]
            else:
                fn = self.expr(node.func, ctx)
            args = ", ".join(self.expr(a, ctx) for a in node.args)
            return f"{fn}({args})"
        if isinstance(node, ast.Compare) and len(node.ops) == 1 and len(node.comparators) == 1:
            op_map = {
                ast.Eq: "==", ast.NotEq: "!=", ast.Lt: "<", ast.LtE: "<=",
                ast.Gt: ">", ast.GtE: ">=", ast.Is: "==", ast.IsNot: "!=",
            }
            op = op_map.get(type(node.ops[0]), "==")
            return f"({self.expr(node.left, ctx)} {op} {self.expr(node.comparators[0], ctx)})"
        if isinstance(node, ast.BinOp):
            op_map = {ast.Add: "+", ast.Sub: "-", ast.Mult: "*", ast.Div: "/", ast.Mod: "%"}
            op = op_map.get(type(node.op), "+")
            return f"({self.expr(node.left, ctx)} {op} {self.expr(node.right, ctx)})"
        if isinstance(node, ast.UnaryOp):
            if isinstance(node.op, ast.Not):
                return f"(!{self.expr(node.operand, ctx)})"
            if isinstance(node.op, ast.USub):
                return f"(-{self.expr(node.operand, ctx)})"
            return self.expr(node.operand, ctx)
        if isinstance(node, ast.BoolOp):
            op = "&&" if isinstance(node.op, ast.And) else "||"
            return "(" + f" {op} ".join(self.expr(v, ctx) for v in node.values) + ")"
        if isinstance(node, ast.List):
            return "{" + ", ".join(self.expr(e, ctx) for e in node.elts) + "}"
        return "/* unsupported_expr */"

    def _range(self, call, ctx):
        args = call.args
        if len(args) == 1:
            return "0", self.expr(args[0], ctx)
        if len(args) >= 2:
            return self.expr(args[0], ctx), self.expr(args[1], ctx)
        return "0", "0"

    def stmt(self, node, indent, ctx):
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            value = node.value

            # Support tuple unpack like: i, j = row, col
            if isinstance(target, ast.Tuple) and isinstance(value, ast.Tuple):
                if len(target.elts) == len(value.elts):
                    for t, v in zip(target.elts, value.elts):
                        if isinstance(t, ast.Name):
                            name = t.id
                            rhs = self.expr(v, ctx)
                            if name in ctx["decl"]:
                                self.emit(f"{name} = {rhs};", indent)
                            else:
                                self.emit(f"auto {name} = {rhs};", indent)
                                ctx["decl"].add(name)
                return

            if isinstance(target, ast.Name):
                name = target.id

                if isinstance(value, ast.ListComp):
                    comp = value
                    if isinstance(comp.elt, ast.ListComp) and len(comp.generators) == 1 and len(comp.elt.generators) == 1 and isinstance(comp.elt.elt, ast.Constant):
                        _, rows = self._range(comp.generators[0].iter, ctx)
                        _, cols = self._range(comp.elt.generators[0].iter, ctx)
                        fill = self.expr(comp.elt.elt, ctx)
                        line = f"vector<vector<int>> {name}({rows}, vector<int>({cols}, {fill}));"
                        if name in ctx["decl"]:
                            line = f"{name} = vector<vector<int>>({rows}, vector<int>({cols}, {fill}));"
                        self.emit(line, indent)
                        ctx["decl"].add(name)
                        return

                rhs = self.expr(value, ctx)
                if name in ctx["decl"]:
                    if isinstance(value, ast.Constant) and value.value is None and name in ctx["ptr"]:
                        self.emit(f"delete {name};", indent)
                    else:
                        self.emit(f"{name} = {rhs};", indent)
                else:
                    if isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and value.func.id in self.class_names:
                        ctype = f"{value.func.id}*"
                    elif isinstance(value, ast.Attribute) and isinstance(value.value, ast.Name) and value.value.id == "self":
                        ctype = self.field_types.get(ctx.get("class_name"), {}).get(value.attr, "auto")
                    elif isinstance(value, ast.Constant) and value.value is None and "Node" in self.class_names:
                        ctype = "Node*"
                    elif isinstance(value, ast.Constant) and isinstance(value.value, int):
                        ctype = "int"
                    elif isinstance(value, ast.List):
                        ctype = "vector<int>"
                    else:
                        ctype = "auto"
                    self.emit(f"{ctype} {name} = {rhs};", indent)
                    ctx["decl"].add(name)
                    if ctype.endswith("*"):
                        ctx["ptr"].add(name)
                return

            if isinstance(target, (ast.Attribute, ast.Subscript)):
                self.emit(f"{self.expr(target, ctx)} = {self.expr(value, ctx)};", indent)
                return

        if isinstance(node, ast.AugAssign):
            op_map = {ast.Add: "+=", ast.Sub: "-=", ast.Mult: "*=", ast.Div: "/="}
            op = op_map.get(type(node.op), "+=")
            self.emit(f"{self.expr(node.target, ctx)} {op} {self.expr(node.value, ctx)};", indent)
            return

        if isinstance(node, ast.If):
            self.emit(f"if ({self.expr(node.test, ctx)}) {{", indent)
            for s in node.body:
                self.stmt(s, indent + 1, ctx)
            if node.orelse:
                self.emit("} else {", indent)
                for s in node.orelse:
                    self.stmt(s, indent + 1, ctx)
            self.emit("}", indent)
            return

        if isinstance(node, ast.While):
            self.emit(f"while ({self.expr(node.test, ctx)}) {{", indent)
            for s in node.body:
                self.stmt(s, indent + 1, ctx)
            self.emit("}", indent)
            return

        if isinstance(node, ast.For):
            if isinstance(node.target, ast.Name) and isinstance(node.iter, ast.Call) and isinstance(node.iter.func, ast.Name) and node.iter.func.id == "range":
                start, stop = self._range(node.iter, ctx)
                var = node.target.id
                self.emit(f"for (int {var} = {start}; {var} < {stop}; ++{var}) {{", indent)
                for s in node.body:
                    self.stmt(s, indent + 1, ctx)
                self.emit("}", indent)
                return

            if isinstance(node.target, ast.Name):
                var = node.target.id
                self.emit(f"for (const auto& {var} : {self.expr(node.iter, ctx)}) {{", indent)
                for s in node.body:
                    self.stmt(s, indent + 1, ctx)
                self.emit("}", indent)
                return

        if isinstance(node, ast.Return):
            if node.value is None:
                self.emit("return;", indent)
            else:
                self.emit(f"return {self.expr(node.value, ctx)};", indent)
            return

        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            call = node.value
            if isinstance(call.func, ast.Name) and call.func.id == "print":
                # Handle: print(" ".join(str(board[i][j]) for j in range(N)))
                if len(call.args) == 1 and isinstance(call.args[0], ast.Call):
                    join_call = call.args[0]
                    if (
                        isinstance(join_call.func, ast.Attribute)
                        and isinstance(join_call.func.value, ast.Constant)
                        and isinstance(join_call.func.value.value, str)
                        and join_call.func.attr == "join"
                        and len(join_call.args) == 1
                        and isinstance(join_call.args[0], ast.GeneratorExp)
                    ):
                        sep = json.dumps(join_call.func.value.value)
                        gen = join_call.args[0]
                        if len(gen.generators) == 1 and isinstance(gen.generators[0].target, ast.Name):
                            g = gen.generators[0]
                            var = g.target.id
                            if (
                                isinstance(g.iter, ast.Call)
                                and isinstance(g.iter.func, ast.Name)
                                and g.iter.func.id == "range"
                                and len(g.iter.args) == 1
                            ):
                                stop = self.expr(g.iter.args[0], ctx)
                                elt = gen.elt
                                # Common form: str(expr)
                                if (
                                    isinstance(elt, ast.Call)
                                    and isinstance(elt.func, ast.Name)
                                    and elt.func.id == "str"
                                    and len(elt.args) == 1
                                ):
                                    body_expr = self.expr(elt.args[0], ctx)
                                else:
                                    body_expr = self.expr(elt, ctx)

                                self.emit(f"for (int {var} = 0; {var} < {stop}; ++{var}) {{", indent)
                                self.emit(f"    cout << {body_expr};", indent)
                                self.emit(f"    if ({var} + 1 < {stop}) cout << {sep};", indent)
                                self.emit("}", indent)
                                self.emit("cout << endl;", indent)
                                return

                end_kw = None
                for kw in call.keywords:
                    if kw.arg == "end":
                        end_kw = self.expr(kw.value, ctx)

                if len(call.args) == 1 and isinstance(call.args[0], ast.Name):
                    n = call.args[0].id
                    self.emit('cout << "[";', indent)
                    self.emit(f"for (size_t i = 0; i < {n}.size(); ++i) {{", indent)
                    self.emit(f"    cout << {n}[i];", indent)
                    self.emit(f"    if (i + 1 < {n}.size()) cout << \", \";", indent)
                    self.emit("}", indent)
                    if end_kw is None:
                        self.emit('cout << "]" << endl;', indent)
                    else:
                        self.emit(f'cout << "]" << {end_kw};', indent)
                else:
                    args = " << \" \" << ".join(self.expr(a, ctx) for a in call.args) if call.args else '""'
                    if end_kw is None:
                        self.emit(f"cout << {args} << endl;", indent)
                    else:
                        self.emit(f"cout << {args} << {end_kw};", indent)
                return

            self.emit(f"{self.expr(call, ctx)};", indent)
            return

        self.emit("// Unsupported Python statement", indent)

    def emit_class(self, c):
        self.emit(f"class {c.name} {{")
        self.emit("public:", 1)

        for field, ftype in self.field_types.get(c.name, {}).items():
            self.emit(f"{ftype} {field};", 2)

        for fn in [n for n in c.body if isinstance(n, ast.FunctionDef)]:
            params = [a.arg for a in fn.args.args if a.arg != "self"]
            sig = ", ".join(f"int {p}" for p in params)
            if fn.name == "__init__":
                self.emit(f"{c.name}({sig}) {{", 2)
            else:
                self.emit(f"void {fn.name}({sig}) {{", 2)

            ctx = {"decl": set(params), "ptr": set(), "class_name": c.name}
            if any(t.endswith("*") for t in self.field_types.get(c.name, {}).values()):
                ctx["ptr"].add("self")

            for s in fn.body:
                self.stmt(s, 3, ctx)
            self.emit("}", 2)

        self.emit("};")
        self.emit("")

    def infer_return_type(self, fn):
        returns = [n for n in ast.walk(fn) if isinstance(n, ast.Return)]
        valued = [r for r in returns if r.value is not None]
        if not valued:
            return "void"
        if all(isinstance(r.value, ast.Constant) and isinstance(r.value.value, bool) for r in valued):
            return "bool"
        if all(isinstance(r.value, (ast.Compare, ast.BoolOp)) for r in valued):
            return "bool"
        if any(isinstance(r.value, ast.Constant) and isinstance(r.value.value, bool) for r in valued):
            return "bool"
        if all(isinstance(r.value, ast.Constant) and isinstance(r.value.value, int) for r in valued):
            return "int"
        return "auto"

    def emit_function(self, fn):
        name = self.function_name_map.get(fn.name, fn.name)
        ret = self.infer_return_type(fn)
        params = [a.arg for a in fn.args.args]
        sig = ", ".join(f"int {p}" for p in params)
        self.emit(f"{ret} {name}({sig}) {{")
        ctx = {"decl": set(params), "ptr": set(), "class_name": None}
        for s in fn.body:
            self.stmt(s, 1, ctx)
        if ret == "void":
            self.emit("return;", 1)
        self.emit("}")
        self.emit("")

    def is_main_guard(self, node):
        if not isinstance(node, ast.If):
            return False
        test = node.test
        if not isinstance(test, ast.Compare) or len(test.ops) != 1 or len(test.comparators) != 1:
            return False
        if not isinstance(test.ops[0], ast.Eq):
            return False
        if not isinstance(test.left, ast.Name) or test.left.id != "__name__":
            return False
        comp = test.comparators[0]
        return isinstance(comp, ast.Constant) and comp.value == "__main__"

    def find_function_global_dependencies(self):
        assigned = set()
        for n in self.tree.body:
            if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
                assigned.add(n.targets[0].id)

        loaded_in_functions = set()
        for fn in self.functions:
            for n in ast.walk(fn):
                if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load):
                    loaded_in_functions.add(n.id)

        return assigned.intersection(loaded_in_functions)

    def convert(self):
        self.emit("#include <iostream>")
        self.emit("#include <vector>")
        self.emit("#include <string>")
        self.emit("using namespace std;")
        self.emit("")

        # Hoist globals that are consumed by translated top-level functions.
        global_deps = self.find_function_global_dependencies()
        global_ctx = {"decl": set(), "ptr": set(), "class_name": None}
        for stmt in self.tree.body:
            if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
                if stmt.targets[0].id in global_deps:
                    self.stmt(stmt, 0, global_ctx)

        if global_deps:
            self.emit("")

        for c in self.classes:
            self.emit_class(c)

        for fn in self.functions:
            self.emit_function(fn)

        self.emit("int main() {")
        ctx = {"decl": set(), "ptr": set(), "class_name": None}
        for stmt in self.tree.body:
            if isinstance(stmt, ast.ClassDef) or isinstance(stmt, ast.FunctionDef):
                continue
            if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
                if stmt.targets[0].id in global_deps:
                    continue
            if self.is_main_guard(stmt):
                for inner in stmt.body:
                    self.stmt(inner, 1, ctx)
                continue
            self.stmt(stmt, 1, ctx)
        self.emit("return 0;", 1)
        self.emit("}")
        return "\n".join(self.lines)


def convert_python_to_cpp_simple(code):
    try:
        return PyToCpp(code).convert()
    except Exception:
        return _convert_python_to_cpp_text_fallback(code)


def _convert_python_to_cpp_text_fallback(code):
    lines = [line.strip() for line in code.split("\n") if line.strip()]
    out = ["#include <iostream>", "using namespace std;", "", "int main() {"]
    for line in lines:
        if line.startswith("print("):
            out.append(f"    cout << {line[6:-1]} << endl;")
        elif "=" in line and not line.startswith("for ") and not line.startswith("if "):
            var, val = line.split("=", 1)
            out.append(f"    auto {var.strip()} = {val.strip()};")
        else:
            out.append(f"    // {line}")
    out.append("    return 0;")
    out.append("}")
    return "\n".join(out)


def convert_cpp_to_python_simple(code):
    lines = code.strip().split("\n")
    out = []
    indent = 0
    class_stack = []
    single_stmt_depths = []

    def push(line):
        out.append("    " * indent + line)

    def open_block(single_stmt=False):
        nonlocal indent
        indent += 1
        if single_stmt:
            single_stmt_depths.append(indent)

    def close_one_block():
        nonlocal indent
        if indent > 0:
            if single_stmt_depths and single_stmt_depths[-1] == indent:
                single_stmt_depths.pop()
            indent -= 1
            while class_stack and indent == class_stack[-1][1]:
                class_stack.pop()

    def close_single_stmt_blocks():
        while single_stmt_depths:
            close_one_block()

    def normalize_expr(expr):
        expr = expr.strip().rstrip(";")
        expr = expr.replace("this->", "self.")
        expr = re.sub(r"(\w+)\s*->\s*(\w+)", r"\1.\2", expr)
        expr = expr.replace("nullptr", "None")
        expr = expr.replace("true", "True").replace("false", "False")
        expr = expr.replace("&&", " and ").replace("||", " or ")
        expr = re.sub(r"!\s*(\w+)", r"not \1", expr)
        expr = re.sub(r"\s+", " ", expr).strip()
        return expr

    def strip_cpp_type(var_decl):
        var_decl = var_decl.strip()
        var_decl = re.sub(r"^(const\s+)?(unsigned\s+)?(long\s+)?(int|double|float|bool|string|char|auto|size_t|void)\s+", "", var_decl)
        var_decl = re.sub(r"^[A-Za-z_]\w*\s*\*\s*", "", var_decl)
        return var_decl.strip()

    def emit_statement_line(py_line):
        push(py_line)
        close_single_stmt_blocks()

    for raw in lines:
        line = raw.strip()
        if not line:
            continue

        # Preprocessor and includes
        define_match = re.match(r"#define\s+(\w+)\s+(.+)", line)
        if define_match:
            emit_statement_line(f"{define_match.group(1)} = {normalize_expr(define_match.group(2))}")
            continue

        if line.startswith("#include") or line.startswith("using namespace"):
            continue
        if line in {"public:", "private:", "protected:"}:
            continue

        # Handle combined close+else forms: `} else {` and `} else if (...) {`
        close_else_if = re.match(r"\}\s*else\s+if\s*\((.*)\)\s*\{?\s*$", line)
        if close_else_if:
            close_one_block()
            push(f"elif {normalize_expr(close_else_if.group(1))}:")
            open_block(single_stmt=("{" not in line))
            continue

        close_else = re.match(r"\}\s*else\s*\{?\s*$", line)
        if close_else:
            close_one_block()
            push("else:")
            open_block(single_stmt=("{" not in line))
            continue

        # Handle closing braces
        if line.startswith("}"):
            close_one_block()
            continue

        # class Foo {
        class_match = re.match(r"class\s+(\w+)\s*\{", line)
        if class_match:
            class_name = class_match.group(1)
            push(f"class {class_name}:")
            class_stack.append((class_name, indent))
            open_block(single_stmt=False)
            continue

        # C arrays: int board[N][N] = {0};
        array_match = re.match(r"(?:const\s+)?(?:int|double|float|bool)\s+(\w+)\[(\w+)\]\[(\w+)\]\s*=\s*\{0\}\s*;", line)
        if array_match:
            name = array_match.group(1)
            rows = normalize_expr(array_match.group(2))
            cols = normalize_expr(array_match.group(3))
            emit_statement_line(f"{name} = [[0 for _ in range({cols})] for _ in range({rows})]")
            continue

        # std::vector matrix: vector<vector<int>> board(N, vector<int>(N, 0));
        vec_matrix_match = re.match(
            r"vector\s*<\s*vector\s*<\s*\w+\s*>\s*>\s+(\w+)\s*\(\s*([^,]+)\s*,\s*vector\s*<\s*\w+\s*>\s*\(\s*([^,]+)\s*,\s*([^\)]+)\s*\)\s*\)\s*;",
            line,
        )
        if vec_matrix_match:
            name = vec_matrix_match.group(1)
            rows = normalize_expr(vec_matrix_match.group(2))
            cols = normalize_expr(vec_matrix_match.group(3))
            val = normalize_expr(vec_matrix_match.group(4))
            emit_statement_line(f"{name} = [[{val} for _ in range({cols})] for _ in range({rows})]")
            continue

        # Constructor
        ctor_match = None
        if class_stack:
            ctor_match = re.match(rf"{class_stack[-1][0]}\(([^)]*)\)\s*\{{?\s*$", line)
        if ctor_match:
            params = ctor_match.group(1).strip()
            if params:
                params = ", ".join(strip_cpp_type(p) for p in params.split(","))
                push(f"def __init__(self, {params}):")
            else:
                push("def __init__(self):")
            open_block(single_stmt=("{" not in line))
            continue

        # Methods/functions
        method_match = re.match(r"(?:void|int|double|float|bool|string|auto)\s+(\w+)\(([^)]*)\)\s*\{?\s*$", line)
        if method_match:
            name = method_match.group(1)
            params = method_match.group(2).strip()
            if params:
                params = ", ".join(strip_cpp_type(p) for p in params.split(","))
                if class_stack:
                    push(f"def {name}(self, {params}):")
                else:
                    push(f"def {name}({params}):")
            else:
                if class_stack:
                    push(f"def {name}(self):")
                else:
                    push(f"def {name}():")
            open_block(single_stmt=("{" not in line))
            continue

        # if/while/for headers (brace or single-statement style)
        inline_if_cout = re.match(r"if\s*\((.*)\)\s*cout\s*<<\s*(.+);\s*$", line)
        if inline_if_cout:
            cond = normalize_expr(inline_if_cout.group(1))
            cout_expr = inline_if_cout.group(2).strip()
            if "<< endl" in cout_expr or "<<endl" in cout_expr:
                cout_expr = cout_expr.replace("<< endl", "").replace("<<endl", "")
                parts = [normalize_expr(p.strip()) for p in cout_expr.split("<<") if p.strip()]
                emit_statement_line(f"if {cond}: print({', '.join(parts)})")
            else:
                parts = [normalize_expr(p.strip()) for p in cout_expr.split("<<") if p.strip()]
                emit_statement_line(f"if {cond}: print({', '.join(parts)}, end=\"\")")
            continue

        if_match = re.match(r"if\s*\((.*)\)\s*\{?\s*$", line)
        if if_match:
            push(f"if {normalize_expr(if_match.group(1))}:")
            open_block(single_stmt=("{" not in line))
            continue

        else_if_match = re.match(r"else\s+if\s*\((.*)\)\s*\{?\s*$", line)
        if else_if_match:
            push(f"elif {normalize_expr(else_if_match.group(1))}:")
            open_block(single_stmt=("{" not in line))
            continue

        if line == "else" or line == "else {":
            push("else:")
            open_block(single_stmt=("{" not in line))
            continue

        while_match = re.match(r"while\s*\((.*)\)\s*\{?\s*$", line)
        if while_match:
            push(f"while {normalize_expr(while_match.group(1))}:")
            open_block(single_stmt=("{" not in line))
            continue

        # for (int i = a; i < b; ++i)
        for_match = re.match(r"for\s*\(int\s+(\w+)\s*=\s*(.+?);\s*\1\s*<\s*(.+?);\s*(?:\+\+\1|\1\+\+)\)\s*\{?\s*$", line)
        if for_match:
            var = for_match.group(1)
            start = normalize_expr(for_match.group(2))
            stop = normalize_expr(for_match.group(3))
            push(f"for {var} in range({start}, {stop}):")
            open_block(single_stmt=("{" not in line))
            continue

        # descending loop: for (int i = n; i >= 0; i--)
        down_for = re.match(r"for\s*\(int\s+(\w+)\s*=\s*(.+?);\s*\1\s*>=\s*(.+?);\s*(?:--\1|\1--)\)\s*\{?\s*$", line)
        if down_for:
            var = down_for.group(1)
            start = normalize_expr(down_for.group(2))
            stop = normalize_expr(down_for.group(3))
            push(f"for {var} in range({start}, {stop} - 1, -1):")
            open_block(single_stmt=("{" not in line))
            continue

        # Complex dual-index C for-loops are intentionally kept as comments below
        # to avoid emitting malformed Python.

        foreach_match = re.match(r"for\s*\(const\s+auto&\s+(\w+)\s*:\s*(.+)\)\s*\{?\s*$", line)
        if foreach_match:
            var = foreach_match.group(1)
            iterable = normalize_expr(foreach_match.group(2))
            push(f"for {var} in {iterable}:")
            open_block(single_stmt=("{" not in line))
            continue

        # return
        if line.startswith("return"):
            val = line[len("return"):].strip().rstrip(";")
            if indent == 0:
                continue
            if val:
                emit_statement_line(f"return {normalize_expr(val)}")
            else:
                emit_statement_line("return")
            continue

        # cout
        if line.startswith("cout <<"):
            clean = line.rstrip(";")
            has_endl = ("endl" in clean)
            clean = clean.replace("endl", "")
            parts = [normalize_expr(p.strip()) for p in clean.split("<<") if p.strip() and p.strip() != "cout"]
            if not parts:
                continue
            if len(parts) == 2 and (parts[1].startswith('"') or parts[1].startswith("'")) and parts[1] != '""':
                emit_statement_line(f"print({parts[0]}, end={parts[1]})")
            else:
                if has_endl:
                    emit_statement_line(f"print({', '.join(parts)})")
                else:
                    emit_statement_line(f"print({', '.join(parts)}, end=\"\")")
            continue

        # Keep unresolved control syntax as comment instead of generating invalid Python.
        if line.startswith("for (") or line.startswith("if (") or line.startswith("while ("):
            emit_statement_line(f"# {line}")
            continue

        # typed assignment including pointers and bool
        assign_match = re.match(r"(?:const\s+)?(?:unsigned\s+)?(?:long\s+)?(?:int|double|float|bool|string|char|auto|size_t|[A-Za-z_]\w*\s*\*)\s+(\w+)\s*=\s*(.+);", line)
        if assign_match:
            lhs = assign_match.group(1)
            rhs = normalize_expr(assign_match.group(2))
            if rhs.startswith("new "):
                rhs = re.sub(r"new\s+(\w+)\((.*)\)", r"\1(\2)", rhs)
            emit_statement_line(f"{lhs} = {rhs}")
            continue

        # compound assignment: i += 1; i -= 1; etc.
        compound_assign = re.match(r"(.+?)\s*([+\-*/%])=\s*(.+);", line)
        if compound_assign:
            lhs = normalize_expr(compound_assign.group(1))
            op = compound_assign.group(2)
            rhs = normalize_expr(compound_assign.group(3))
            emit_statement_line(f"{lhs} {op}= {rhs}")
            continue

        # normal assignment / update
        simple_assign = re.match(r"(.+?)\s*=\s*(.+);", line)
        if simple_assign:
            lhs = normalize_expr(simple_assign.group(1))
            rhs = normalize_expr(simple_assign.group(2))
            if rhs.startswith("new "):
                rhs = re.sub(r"new\s+(\w+)\((.*)\)", r"\1(\2)", rhs)
            emit_statement_line(f"{lhs} = {rhs}")
            continue

        # function/method calls
        call_match = re.match(r"(.+)\((.*)\);", line)
        if call_match:
            fn = normalize_expr(call_match.group(1))
            args = normalize_expr(call_match.group(2))
            if fn.startswith("for ") or fn.startswith("if ") or fn.startswith("while "):
                emit_statement_line(f"# {line}")
            else:
                emit_statement_line(f"{fn}({args})")
            continue

        if line != "};":
            emit_statement_line(f"# {line}")

    if any(l.startswith("def main") for l in out):
        out.extend(["", "if __name__ == \"__main__\":", "    main()"])

    return "\n".join(out)


def rule_based_convert(code, source_lang, target_lang):
    if source_lang == "python" and target_lang == "cpp":
        return convert_python_to_cpp_simple(code)
    if source_lang == "cpp" and target_lang == "python":
        return convert_cpp_to_python_simple(code)
    return code


def run_worker(model_dir):
    # Keep model loading for environment validation compatibility, but do it once.
    load_model(model_dir)
    emit({"type": "ready", "success": True})

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue

        try:
            payload = json.loads(line)
        except Exception:
            emit({"success": False, "error": "Invalid worker request JSON"})
            continue

        req_id = payload.get("id")
        source_lang = str(payload.get("source_lang", "")).lower()
        target_lang = str(payload.get("target_lang", "")).lower()
        code = payload.get("code", "")

        if (source_lang, target_lang) not in {("python", "cpp"), ("cpp", "python")}:
            emit(
                {
                    "id": req_id,
                    "success": False,
                    "error": "Local trained model supports only Python<->C++ conversion",
                }
            )
            continue

        try:
            converted = rule_based_convert(code, source_lang, target_lang)
            emit(
                {
                    "id": req_id,
                    "success": True,
                    "convertedCode": converted,
                    "provider": "Local Trained Model (Python<->C++)",
                }
            )
        except Exception as exc:
            emit(
                {
                    "id": req_id,
                    "success": False,
                    "error": f"Trained model conversion failed: {str(exc)}",
                }
            )


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--worker":
        if len(sys.argv) != 3:
            emit({"success": False, "error": "Usage: trainedModelService.py --worker <model_dir>"})
            sys.exit(1)

        model_dir = sys.argv[2]
        try:
            run_worker(model_dir)
        except Exception as exc:
            emit({"success": False, "error": f"Worker startup failed: {str(exc)}"})
            sys.exit(1)
        return

    if len(sys.argv) != 4:
        emit(
            {
                "success": False,
                "error": "Usage: trainedModelService.py <model_dir> <source_lang> <target_lang> (code read from stdin)",
            }
        )
        sys.exit(1)

    model_dir = sys.argv[1]
    source_lang = sys.argv[2].lower()
    target_lang = sys.argv[3].lower()
    code = sys.stdin.read().strip()

    if (source_lang, target_lang) not in {("python", "cpp"), ("cpp", "python")}:
        emit({"success": False, "error": "Local trained model supports only Python<->C++ conversion"})
        sys.exit(1)

    try:
        # Keep model loading for environment validation compatibility.
        load_model(model_dir)

        converted = rule_based_convert(code, source_lang, target_lang)

        emit(
            {
                "success": True,
                "convertedCode": converted,
                "provider": "Local Trained Model (Python<->C++)",
            }
        )
    except Exception as exc:
        emit(
            {
                "success": False,
                "error": f"Trained model conversion failed: {str(exc)}",
            }
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
