// Currency and combat health share the same nonnegative integer transaction contract.
// Existing trading adapters and host hooks remain compatible.
export { MapTradeState as MapStateTransactions } from './tradeState.js'

export type {
  ITradeState as IStateTransactions,
  TradeStateWrite as StateWrite,
  PreparedTradeState as PreparedStateWrites,
} from './tradeState.js'
