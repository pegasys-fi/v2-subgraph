/* eslint-disable prefer-const */
import { Address, BigDecimal, BigInt } from '@graphprotocol/graph-ts/index'

import { Bundle, Pair, Token } from '../types/schema'
import { ADDRESS_ZERO, factoryContract, ONE_BD, UNTRACKED_PAIRS, ZERO_BD } from './helpers'

// // Rollux
const WSYS_ADDRESS = '0x4200000000000000000000000000000000000006'
const USDC_WSYS_PAIR = '0x2472d59e188c95ebb4a5f8ff380e8e182b1f7bab'
const USDT_WSYS_PAIR = '0x35f86987e9be51d950dfa747fe2a18603297b2ee'

export function getSysPriceInUSD(): BigDecimal {

  let usdcPair = Pair.load(USDC_WSYS_PAIR) // usdc is token0
  let usdtPair = Pair.load(USDT_WSYS_PAIR) // usdt is token0

  if (usdtPair !== null && usdcPair !== null) {
    let totalLiquiditySYS = usdtPair.reserve1.plus(usdcPair.reserve1)
    let daiWeight = usdtPair.reserve1.div(totalLiquiditySYS)
    let usdcWeight = usdcPair.reserve0.div(totalLiquiditySYS)
    return usdtPair.token0Price.times(daiWeight).plus(usdcPair.token0Price.times(usdcWeight))
    // USDT is the only pair so far
  } else if (usdtPair !== null) {
    return usdtPair.token0Price
  } else {
    return ZERO_BD
  }
}

// token where amounts should contribute to tracked volume and liquidity
let WHITELIST: string[] = [
  // //ROLLUX
  '0x4200000000000000000000000000000000000006', // WSYS
  '0x48023b16c3e81aa7f6effbdeb35bb83f4f31a8fd', // PSYS
  '0x2a4dc2e946b92ab4a1f7d62844eb237788f9056c', // WBTC
  '0xaa1c53afd099e415208f47fcfa2c880f659e6904', // WETH
  '0x368433cac2a0b8d76e64681a9835502a1f2a8a30', // USDC
  '0x28c9c7fb3fe3104d2116af26cc8ef7905547349c', // USDT
]

// minimum liquidity required to count towards tracked volume for pairs with small # of Lps
let MINIMUM_USD_THRESHOLD_NEW_PAIRS = BigDecimal.fromString('400000')

// minimum liquidity for price to get tracked
let MINIMUM_LIQUIDITY_THRESHOLD_SYS = BigDecimal.fromString('100')

/**
 * Search through graph to find derived Sys per token.
 * @todo update to be derived SYS (add stablecoin estimates)
 **/
export function findSysPerToken(token: Token): BigDecimal {
  if (token.id == WSYS_ADDRESS) {
    return ONE_BD
  }
  // loop through whitelist and check if paired with any
  for (let i = 0; i < WHITELIST.length; ++i) {
    let pairAddress = factoryContract.getPair(Address.fromString(token.id), Address.fromString(WHITELIST[i]))
    if (pairAddress.toHexString() != ADDRESS_ZERO) {
      let pair = Pair.load(pairAddress.toHexString())
      if (pair === null) {
        continue
      }
      if (pair.token0 == token.id && pair.reserveSYS.gt(MINIMUM_LIQUIDITY_THRESHOLD_SYS)) {
        let token1 = Token.load(pair.token1)
        if (token1 === null) {
          continue
        }
        return pair.token1Price.times(token1.derivedSYS as BigDecimal) // return token1 per our token * Sys per token 1
      }
      if (pair.token1 == token.id && pair.reserveSYS.gt(MINIMUM_LIQUIDITY_THRESHOLD_SYS)) {
        let token0 = Token.load(pair.token0)
        if (token0 === null) {
          continue
        }
        return pair.token0Price.times(token0.derivedSYS as BigDecimal) // return token0 per our token * SYS per token 0
      }
    }
  }
  return ZERO_BD // nothing was found return 0
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD.
 * If both are, return average of two amounts
 * If neither is, return 0
 */
export function getTrackedVolumeUSD(
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token,
  pair: Pair,
): BigDecimal {
  let bundle = Bundle.load('1')!
  let price0 = token0.derivedSYS.times(bundle.sysPrice)
  let price1 = token1.derivedSYS.times(bundle.sysPrice)

  // dont count tracked volume on these pairs - usually rebass tokens
  if (UNTRACKED_PAIRS.includes(pair.id)) {
    return ZERO_BD
  }

  // if less than 5 LPs, require high minimum reserve amount amount or return 0
  if (pair.liquidityProviderCount.lt(BigInt.fromI32(5))) {
    let reserve0USD = pair.reserve0.times(price0)
    let reserve1USD = pair.reserve1.times(price1)
    if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
      if (reserve0USD.plus(reserve1USD).lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)) {
        return ZERO_BD
      }
    }
    if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
      if (reserve0USD.times(BigDecimal.fromString('2')).lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)) {
        return ZERO_BD
      }
    }
    if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
      if (reserve1USD.times(BigDecimal.fromString('2')).lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)) {
        return ZERO_BD
      }
    }
  }

  // both are whitelist tokens, take average of both amounts
  if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0).plus(tokenAmount1.times(price1)).div(BigDecimal.fromString('2'))
  }

  // take full value of the whitelisted token amount
  if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0)
  }

  // take full value of the whitelisted token amount
  if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount1.times(price1)
  }

  // neither token is on white list, tracked volume is 0
  return ZERO_BD
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD * 2.
 * If both are, return sum of two amounts
 * If neither is, return 0
 */
export function getTrackedLiquidityUSD(
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token,
): BigDecimal {
  let bundle = Bundle.load('1')!
  let price0 = token0.derivedSYS.times(bundle.sysPrice)
  let price1 = token1.derivedSYS.times(bundle.sysPrice)

  // both are whitelist tokens, take average of both amounts
  if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0).plus(tokenAmount1.times(price1))
  }

  // take double value of the whitelisted token amount
  if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0).times(BigDecimal.fromString('2'))
  }

  // take double value of the whitelisted token amount
  if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount1.times(price1).times(BigDecimal.fromString('2'))
  }

  // neither token is on white list, tracked volume is 0
  return ZERO_BD
}
