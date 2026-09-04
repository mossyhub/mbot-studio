"""CPython artifact checks only; never import/execute generated hardware code.

Dev prerequisite: python3. Evaluate only AST-whitelisted fixture expressions.
"""
import ast
import json
import math
import sys

BUILTINS = {"int": int, "str": str, "len": len, "abs": abs, "round": round,
            "bool": bool, "__import__": lambda name: math if name == "math" else None}
NODES = (ast.Expression, ast.Constant, ast.Name, ast.Load, ast.Call, ast.BinOp,
         ast.UnaryOp, ast.USub, ast.UAdd, ast.Not, ast.Add, ast.Sub, ast.Mult,
         ast.Div, ast.FloorDiv, ast.Mod, ast.Pow, ast.Compare, ast.Eq, ast.NotEq,
         ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.In, ast.NotIn, ast.BoolOp,
         ast.And, ast.Or, ast.IfExp, ast.Subscript, ast.Attribute, ast.Is, ast.IsNot)


def safe_value(node, scope, pure_calls=None):
    builtins = {**BUILTINS, **(pure_calls or {})}
    for item in ast.walk(node):
        assert isinstance(item, NODES), f"Unsafe expression node: {type(item).__name__}"
        if isinstance(item, ast.Attribute):
            assert (item.attr == "floor" and isinstance(item.value, ast.Call)
                    and isinstance(item.value.func, ast.Name)
                    and item.value.func.id == "__import__"
                    and len(item.value.args) == 1
                    and isinstance(item.value.args[0], ast.Constant)
                    and item.value.args[0].value == "math"), "Unsafe attribute"
        if isinstance(item, ast.Call):
            assert not item.keywords, "Unsafe keyword arguments"
            if isinstance(item.func, ast.Name):
                assert item.func.id in builtins, "Unsafe function"
                if item.func.id == "__import__":
                    assert len(item.args) == 1 and isinstance(item.args[0], ast.Constant)
                    assert item.args[0].value == "math", "Unsafe import"
            else:
                assert isinstance(item.func, ast.Attribute), "Unsafe call"
    return eval(compile(ast.Expression(body=node), "<safe-expression>", "eval"),
                {"__builtins__": builtins}, scope)


def call_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = call_name(node.value)
        return f"{parent}.{node.attr}" if parent else None
    return None


def slow_servo(program, request):
    """Interpret only the generated counter logic, NOT a robot/firmware simulator.

    Remove the getter statement (inject an explicit initial-angle fixture), setter
    statements (retain only their pure angle expressions), and sleep statements.
    Replace only random.randint reporter calls with a counted deterministic input.
    No generated imports or hardware calls are executed. Unknown calls fail closed.
    """
    samples = request.get("samples", [])
    sample_count = 0

    def sample(low, high):
        nonlocal sample_count
        assert samples, "A random reporter needs explicit sample fixtures"
        value = samples[sample_count % len(samples)]
        assert low <= value <= high
        sample_count += 1
        return value

    class PureCounter(ast.NodeTransformer):
        def visit_Assign(self, node):
            if (isinstance(node.value, ast.Call)
                    and call_name(node.value.func) == "mbot2.starter_shield.servo_get_angle"):
                assert len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
                assert node.targets[0].id == "_sv_cur"
                node.value = ast.Constant(request["initial"])
            return self.generic_visit(node)

        def visit_Expr(self, node):
            assert isinstance(node.value, ast.Call), "Only explicit removed calls are allowed"
            name = call_name(node.value.func)
            assert not node.value.keywords
            if name == "time.sleep":
                return None  # Timing is deliberately outside this pure check.
            assert name == "mbot2.starter_shield.servo_set_angle", "Forbidden hardware statement"
            assert len(node.value.args) == 2
            return ast.copy_location(ast.Assign(
                targets=[ast.Name(id="_test_angle", ctx=ast.Store())],
                value=self.visit(node.value.args[1])), node)

        def visit_Call(self, node):
            if (isinstance(node.func, ast.Attribute) and node.func.attr == "randint"
                    and isinstance(node.func.value, ast.Call)
                    and call_name(node.func.value.func) == "__import__"
                    and len(node.func.value.args) == 1
                    and isinstance(node.func.value.args[0], ast.Constant)
                    and node.func.value.args[0].value == "random"):
                assert not node.func.value.keywords
                node.func = ast.Name(id="_test_sample", ctx=ast.Load())
            return self.generic_visit(node)

    pure = ast.fix_missing_locations(PureCounter().visit(program))
    scope = dict(request.get("scope", {}))
    pure_calls = {"_test_sample": sample}
    # Validate ALL retained nodes before interpreting any of them. Hardware
    # attributes/imports cannot survive this pass, including in untaken branches.
    statements = (ast.Assign, ast.AugAssign, ast.If, ast.While)
    for node in ast.walk(pure):
        if isinstance(node, ast.stmt):
            assert isinstance(node, statements), "Forbidden counter statement"
        if isinstance(node, ast.Call):
            assert isinstance(node.func, ast.Name) and node.func.id in {"int", "_test_sample"}, "Forbidden counter call"
        assert not isinstance(node, (ast.Attribute, ast.Import, ast.ImportFrom)), "Forbidden hardware attribute/import"

    angles = []
    iterations = 0

    def value(node):
        return safe_value(node, scope, pure_calls)

    def run(body):
        nonlocal iterations
        for node in body:
            if isinstance(node, ast.Assign):
                assert len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
                name = node.targets[0].id
                assert name not in BUILTINS and name not in pure_calls
                scope[name] = value(node.value)
                if name == "_test_angle":
                    angles.append(scope[name])
            elif isinstance(node, ast.AugAssign):
                assert isinstance(node.target, ast.Name) and isinstance(node.op, ast.Add)
                scope[node.target.id] += value(node.value)
            elif isinstance(node, ast.If):
                run(node.body if value(node.test) else node.orelse)
            elif isinstance(node, ast.While):
                assert not node.orelse
                while value(node.test):
                    if iterations >= 300:
                        raise TimeoutError("counter did not terminate within 300 steps")
                    iterations += 1
                    run(node.body)

    terminated = True
    try:
        run(pure.body)
    except TimeoutError:
        terminated = False
    return {"terminated": terminated, "iterations": iterations,
            "current": scope.get("_sv_cur"), "angles": angles,
            "sampleCount": sample_count, "pureSource": ast.unparse(pure)}


def check(request):
    source = request["source"]
    tree = ast.parse(source, filename="<generated>")
    compile(tree, "<generated>", "exec")  # catches return outside function too
    body = source.split("# --- Program Start ---\n", 1)[1].split("\n# Program complete", 1)[0]
    program = ast.parse(body)
    result = {"compiled": True, "passCount": sum(isinstance(n, ast.Pass) for n in ast.walk(program))}
    scope = request.get("scope", {})
    if request.get("assignments"):
        scope = dict(scope)
        for statement in program.body:
            assert isinstance(statement, ast.Assign), "Only isolated assignments may execute"
            assert len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name)
            name = statement.targets[0].id
            assert name not in BUILTINS, "Cannot shadow safe builtins"
            scope[name] = safe_value(statement.value, scope)
        result["values"] = scope
    if request.get("slowServo"):
        result["counter"] = slow_servo(program, request)
    if "call" in request:
        # Inspect calls, but execute ONLY individually whitelisted argument expressions.
        calls = [n for n in ast.walk(program) if isinstance(n, ast.Call) and call_name(n.func) == request["call"]]
        result["args"] = [[safe_value(n.args[index], scope) for index in request["indices"]] for n in calls]
    return result


requests = json.load(sys.stdin)
print(json.dumps([check(request) for request in requests]))
