const typescript = require('tree-sitter-typescript/typescript/grammar');
module.exports = grammar(typescript, {
  name: 'jevascript',
  conflicts: ($, previous) => [...previous, [$.primary_expression, $.decision_statement], [$.primary_expression, $.decision_route_statement]],
  rules: {
    primary_expression: ($, previous) => choice(previous, alias('decide', $.identifier)),
    statement: ($, previous) => choice(previous, $.decision_statement, $.decision_route_statement),
    decision_statement: $ => prec.right(seq(
      'decide', field('arguments', $.arguments),
      repeat(seq('.', choice('threshold', 'and'), $.arguments)),
      field('consequence', $.statement_block),
      optional(seq('else', field('alternative', choice($.statement_block, $.decision_statement, $.if_statement)))),
    )),
    decision_route_statement: $ => seq('decide', '.', 'route', $.arguments, field('body', $.switch_body)),
  },
});
