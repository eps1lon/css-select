/*
	Compiles a selector to an executable function
*/

import { parse, Selector } from "css-what";
import { trueFunc, falseFunc } from "boolbase";
import sortRules from "./sort";
import procedure from "./procedure";
import Rules from "./general";
import { filters, pseudos } from "./pseudos";
import { CompiledQuery, InternalOptions } from "./types";
import { Traversal } from "css-what";

export function compile(
    selector: string,
    options: InternalOptions,
    context?: Array<{}>
) {
    const next = compileUnsafe(selector, options, context);
    return wrap(next, options);
}

export const Pseudos = { filters, pseudos };

function wrap(next: CompiledQuery, options: InternalOptions): CompiledQuery {
    const adapter = options.adapter;

    return function base(elem) {
        return adapter.isTag(elem) && next(elem);
    };
}

export function compileUnsafe(
    selector: string,
    options: InternalOptions,
    context?: Array<{}>
) {
    const token = parse(selector, options);
    return compileToken(token, options, context);
}

function includesScopePseudo(t: Selector): boolean {
    return (
        t.type === "pseudo" &&
        (t.name === "scope" ||
            (Array.isArray(t.data) &&
                t.data.some(data => data.some(includesScopePseudo))))
    );
}

const DESCENDANT_TOKEN: Selector = { type: "descendant" };
// @ts-ignore
const FLEXIBLE_DESCENDANT_TOKEN: Selector = { type: "_flexibleDescendant" };
const SCOPE_TOKEN: Selector = { type: "pseudo", name: "scope", data: null };
const PLACEHOLDER_ELEMENT = {};

//CSS 4 Spec (Draft): 3.3.1. Absolutizing a Scope-relative Selector
//http://www.w3.org/TR/selectors4/#absolutizing
function absolutize(
    token: Selector[][],
    options: InternalOptions,
    context?: Array<{}>
) {
    const adapter = options.adapter;

    //TODO better check if context is document
    const hasContext =
        !!context &&
        !!context.length &&
        context.every(e => e === PLACEHOLDER_ELEMENT || !!adapter.getParent(e));

    token.forEach(t => {
        if (t.length > 0 && isTraversal(t[0]) && t[0].type !== "descendant") {
            //don't return in else branch
        } else if (hasContext && !t.some(includesScopePseudo)) {
            t.unshift(DESCENDANT_TOKEN);
        } else {
            return;
        }

        t.unshift(SCOPE_TOKEN);
    });
}

export function compileToken(
    token: Selector[][],
    options: InternalOptions,
    context?: Array<{}>
) {
    token = token.filter(t => t.length > 0);

    token.forEach(sortRules);

    const isArrayContext = Array.isArray(context);

    context = (options && options.context) || context;

    if (context && !isArrayContext) context = [context];

    absolutize(token, options, context);

    let shouldTestNextSiblings = false;

    const query = token
        .map(rules => {
            if (rules.length >= 2) {
                const [first, second] = rules;

                if (first.type !== "pseudo" || first.name !== "scope") {
                    // ignore
                } else if (isArrayContext && second.type === "descendant") {
                    rules[1] = FLEXIBLE_DESCENDANT_TOKEN;
                } else if (
                    second.type === "adjacent" ||
                    second.type === "sibling"
                ) {
                    shouldTestNextSiblings = true;
                }
            }

            return compileRules(rules, options, context);
        })
        .reduce(reduceRules, falseFunc);

    // @ts-ignore
    query.shouldTestNextSiblings = shouldTestNextSiblings;

    return query;
}

function isTraversal(t: Selector): t is Traversal {
    return procedure[t.type] < 0;
}

function compileRules(
    rules: Selector[],
    options: InternalOptions,
    context?: Array<{}>
): CompiledQuery {
    return rules.reduce(
        (previous, rule) =>
            previous === falseFunc
                ? falseFunc
                : Rules[rule.type](
                      previous,
                      // @ts-ignore
                      rule,
                      options,
                      context
                  ),
        (options && options.rootFunc) || trueFunc
    );
}

function reduceRules(a: CompiledQuery, b: CompiledQuery): CompiledQuery {
    if (b === falseFunc || a === trueFunc) {
        return a;
    }
    if (a === falseFunc || b === trueFunc) {
        return b;
    }

    return function combine(elem) {
        return a(elem) || b(elem);
    };
}

function containsTraversal(t: Selector[]): boolean {
    return t.some(isTraversal);
}

//:not, :has and :matches have to compile selectors
//doing this in src/pseudos.ts would lead to circular dependencies,
//so we add them here
filters.not = function(
    next: CompiledQuery,
    token: Selector[][],
    options: InternalOptions,
    context?: Array<{}>
): CompiledQuery {
    const opts = {
        xmlMode: !!options.xmlMode,
        strict: !!options.strict,
        adapter: options.adapter
    };

    if (opts.strict) {
        if (token.length > 1 || token.some(containsTraversal)) {
            throw new Error(
                "complex selectors in :not aren't allowed in strict mode"
            );
        }
    }

    const func = compileToken(token, opts, context);

    if (func === falseFunc) return next;
    if (func === trueFunc) return falseFunc;

    return function not(elem) {
        return !func(elem) && next(elem);
    };
};

filters.has = function(
    next: CompiledQuery,
    token: Selector[][],
    options: InternalOptions
): CompiledQuery {
    const adapter = options.adapter;
    const opts = {
        xmlMode: !!(options && options.xmlMode),
        strict: !!(options && options.strict),
        adapter
    };

    //FIXME: Uses an array as a pointer to the current element (side effects)
    const context = token.some(containsTraversal)
        ? [PLACEHOLDER_ELEMENT]
        : undefined;

    let func = compileToken(token, opts, context);

    if (func === falseFunc) return falseFunc;
    if (func === trueFunc) {
        return function hasChild(elem) {
            return adapter.getChildren(elem).some(adapter.isTag) && next(elem);
        };
    }

    func = wrap(func, options);

    if (context) {
        return function has(elem) {
            return (
                next(elem) &&
                ((context[0] = elem),
                adapter.existsOne(func, adapter.getChildren(elem)))
            );
        };
    }

    return function has(elem) {
        return next(elem) && adapter.existsOne(func, adapter.getChildren(elem));
    };
};

filters.matches = function(
    next: CompiledQuery,
    token: Selector[][],
    options: InternalOptions,
    context?: Array<{}>
): CompiledQuery {
    const opts = {
        xmlMode: !!options.xmlMode,
        strict: !!options.strict,
        rootFunc: next,
        adapter: options.adapter
    };

    return compileToken(token, opts, context);
};
