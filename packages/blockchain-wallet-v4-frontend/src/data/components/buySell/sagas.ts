import BigNumber from 'bignumber.js'
import { getQuote } from 'blockchain-wallet-v4-frontend/src/modals/BuySell/EnterAmount/Checkout/validation'
import { addSeconds, differenceInMilliseconds } from 'date-fns'
import { defaultTo, filter, prop } from 'ramda'
import { call, cancel, delay, fork, put, race, retry, select, take } from 'redux-saga/effects'

import { Remote } from '@core'
import { UnitType } from '@core/exchange'
import Currencies from '@core/exchange/currencies'
import { APIType } from '@core/network/api'
import {
  ApplePayInfoType,
  BSAccountType,
  BSCardStateType,
  BSOrderType,
  BSPaymentMethodType,
  BSPaymentTypes,
  BSQuoteType,
  CardAcquirer,
  FiatEligibleType,
  FiatType,
  GooglePayInfoType,
  MobilePaymentType,
  OrderType,
  ProductTypes,
  SwapOrderType,
  WalletFiatType,
  WalletOptionsType
} from '@core/types'
import { errorCodeAndMessage, errorHandler, errorHandlerCode } from '@core/utils'
import { actions, selectors } from 'data'
import { PartialClientErrorProperties } from 'data/analytics/types/errors'
import { generateProvisionalPaymentAmount } from 'data/coins/utils'
import {
  AddBankStepType,
  BankPartners,
  BankTransferAccountType,
  BrokerageModalOriginType,
  CustodialSanctionsEnum,
  ModalName,
  ProductEligibilityForUser,
  UserDataType
} from 'data/types'

import { actions as custodialActions } from '../../custodial/slice'
import profileSagas from '../../modules/profile/sagas'
import brokerageSagas from '../brokerage/sagas'
import { convertBaseToStandard, convertStandardToBase } from '../exchange/services'
import sendSagas from '../send/sagas'
import { FALLBACK_DELAY, getOutputFromPair } from '../swap/model'
import swapSagas from '../swap/sagas'
import { SwapBaseCounterTypes } from '../swap/types'
import { getRate } from '../swap/utils'
import { selectReceiveAddress } from '../utils/sagas'
import {
  BS_ERROR,
  CARD_ERROR_CODE,
  DEFAULT_BS_BALANCES,
  DEFAULT_BS_METHODS,
  FORM_BS_CANCEL_ORDER,
  FORM_BS_CHECKOUT,
  FORM_BS_CHECKOUT_CONFIRM,
  FORM_BS_PREVIEW_SELL,
  FORMS_BS_BILLING_ADDRESS,
  getCoinFromPair,
  getFiatFromPair,
  GOOGLE_PAY_MERCHANT_ID,
  isFiatCurrencySupported,
  POLLING,
  SDD_TIER
} from './model'
import * as S from './selectors'
import { actions as A } from './slice'
import * as T from './types'
import { getDirection, getPreferredCurrency, reversePair, setPreferredCurrency } from './utils'

export const logLocation = 'components/buySell/sagas'

let googlePaymentsClient: google.payments.api.PaymentsClient | null = null

export default ({ api, coreSagas, networks }: { api: APIType; coreSagas: any; networks: any }) => {
  const { createUser, isTier2, waitForUserData } = profileSagas({
    api,
    coreSagas,
    networks
  })
  const { buildAndPublishPayment, paymentGetOrElse } = sendSagas({
    api,
    coreSagas,
    networks
  })
  const { calculateProvisionalPayment } = swapSagas({
    api,
    coreSagas,
    networks
  })
  const { fetchBankTransferAccounts } = brokerageSagas({ api, coreSagas, networks })

  const generateApplePayToken = async ({
    applePayInfo,
    paymentRequest
  }: {
    applePayInfo: ApplePayInfoType
    paymentRequest: ApplePayJS.ApplePayPaymentRequest
  }) => {
    if (!ApplePaySession) {
      throw new Error(BS_ERROR.APPLE_PAY_INFO_NOT_FOUND)
    }

    const token = await new Promise((resolve, reject) => {
      const session = new ApplePaySession(3, paymentRequest)

      session.onvalidatemerchant = async (event) => {
        try {
          const { applePayPayload } = await api.validateApplePayMerchant({
            beneficiaryID: applePayInfo.beneficiaryID,
            domain: window.location.host,
            validationURL: event.validationURL
          })

          session.completeMerchantValidation(JSON.parse(applePayPayload))
        } catch (e) {
          session.abort()

          reject(new Error(BS_ERROR.FAILED_TO_VALIDATE_APPLE_PAY_MERCHANT))
        }
      }

      session.onpaymentauthorized = (event) => {
        const result = {
          status: ApplePaySession.STATUS_SUCCESS
        }

        session.completePayment(result)

        resolve(JSON.stringify(event.payment.token))
      }

      session.oncancel = () => {
        reject(new Error(BS_ERROR.USER_CANCELLED_APPLE_PAY))
      }

      session.begin()
    })

    return token
  }

  const generateGooglePayToken = async (
    paymentRequest: google.payments.api.PaymentDataRequest
  ): Promise<string> => {
    const environment = window.location.host === 'login.blockchain.com' ? 'PRODUCTION' : 'TEST'

    if (!googlePaymentsClient) {
      googlePaymentsClient = new google.payments.api.PaymentsClient({ environment })
    }

    try {
      const paymentData = await googlePaymentsClient.loadPaymentData(paymentRequest)

      return paymentData.paymentMethodData.tokenizationData.token
    } catch (e) {
      throw new Error(BS_ERROR.FAILED_TO_GENERATE_GOOGLE_PAY_TOKEN)
    }
  }

  const registerBSCard = function* ({ payload }: ReturnType<typeof A.registerCard>) {
    try {
      const { cvv, paymentMethodTokens } = payload
      const userDataR = selectors.modules.profile.getUserData(yield select())
      const billingAddressForm: T.BSBillingAddressFormValuesType | undefined = yield select(
        selectors.form.getFormValues(FORMS_BS_BILLING_ADDRESS)
      )
      const userData = userDataR.getOrFail(BS_ERROR.NO_USER_DATA)
      const address = billingAddressForm || userData.address

      if (!address) throw new Error(BS_ERROR.NO_ADDRESS)

      // We always use CHECKOUTDOTCOM for now
      // and we need 3DS to create a card
      yield put(A.setStep({ step: '3DS_HANDLER_CHECKOUTDOTCOM' }))

      // This creates the card on the backend
      yield put(A.createCard(paymentMethodTokens))
      yield take([A.createCardSuccess.type, A.createCardFailure.type])

      // Check if the card was created
      const cardR = S.getBSCard(yield select())
      const card = cardR.getOrFail(BS_ERROR.CARD_CREATION_FAILED)

      // This is for the 0 dollar payment
      yield put(A.activateCard({ card, cvv }))
      yield take([A.activateCardSuccess.type, A.activateCardFailure.type])
    } catch (e) {
      // TODO: improve error message here, adding translations and more context

      yield put(
        A.setStep({
          step: 'DETERMINE_CARD_PROVIDER'
        })
      )
    }
  }

  const activateBSCard = function* ({ payload }: ReturnType<typeof A.activateCard>) {
    try {
      const { card, cvv } = payload

      yield put(A.activateCardLoading())
      const domainsR = selectors.core.walletOptions.getDomains(yield select())
      const domains = domainsR.getOrElse({
        walletHelper: 'https://wallet-helper.blockchain.com'
      } as WalletOptionsType['domains'])

      const redirectUrl = `${domains.walletHelper}/wallet-helper/3ds-payment-success/#/`

      const providerDetails = yield call(api.activateBSCard, {
        cardBeneficiaryId: card.id,
        cvv,
        redirectUrl
      })

      yield put(A.activateCardSuccess(providerDetails))

      yield put(A.fetchCards(true))
    } catch (e) {
      const error = errorHandlerCode(e)

      yield put(A.activateCardFailure(error))
    }
  }

  const cancelBSOrder = function* ({ payload }: ReturnType<typeof A.cancelOrder>) {
    try {
      const { state } = payload
      const fiatCurrency = getFiatFromPair(payload.pair)
      const cryptoCurrency = getCoinFromPair(payload.pair)
      yield put(actions.form.startSubmit(FORM_BS_CANCEL_ORDER))
      yield call(api.cancelBSOrder, payload)
      yield put(actions.form.stopSubmit(FORM_BS_CANCEL_ORDER))
      yield put(A.fetchOrders())
      if (state === 'PENDING_CONFIRMATION' && fiatCurrency && cryptoCurrency) {
        const pair = S.getBSPair(yield select())
        const method = S.getBSPaymentMethod(yield select())
        if (pair) {
          yield put(
            A.setStep({
              cryptoCurrency,
              fiatCurrency,
              method,
              orderType: payload.side || OrderType.BUY,
              pair,
              step: 'ENTER_AMOUNT'
            })
          )
        } else {
          yield put(
            A.setStep({
              fiatCurrency,
              step: 'CRYPTO_SELECTION'
            })
          )
        }
      } else {
        yield put(actions.modals.closeModal('SIMPLE_BUY_MODAL'))
      }
    } catch (e) {
      // TODO: adding error handling with different error types and messages
      const error = errorHandler(e)
      yield put(actions.form.stopSubmit(FORM_BS_CANCEL_ORDER, { _error: error }))
    }
  }

  const createBSOrder = function* ({
    payload: { mobilePaymentMethod, paymentMethodId, paymentType }
  }: ReturnType<typeof A.createOrder>) {
    const values: T.BSCheckoutFormValuesType = yield select(
      selectors.form.getFormValues(FORM_BS_CHECKOUT)
    )
    const isFlexiblePricingModel = (yield select(
      selectors.core.walletOptions.getFlexiblePricingModel
    )).getOrElse(false)
    try {
      const pair = S.getBSPair(yield select())

      if (!values) throw new Error(BS_ERROR.NO_AMOUNT)
      if (!pair) throw new Error(BS_ERROR.NO_PAIR_SELECTED)
      if (parseFloat(values.amount) <= 0) throw new Error(BS_ERROR.NO_AMOUNT)
      const { fix, orderType, period } = values

      // since two screens use this order creation saga and they have different
      // forms, detect the order type and set correct form to submitting
      let buyQuote
      if (orderType === OrderType.SELL) {
        yield put(actions.form.startSubmit(FORM_BS_PREVIEW_SELL))
      } else {
        if (isFlexiblePricingModel) {
          buyQuote = S.getBuyQuote(yield select()).getOrFail(BS_ERROR.NO_QUOTE)
        }
        yield put(actions.form.startSubmit(FORM_BS_CHECKOUT))
      }

      const fiat = getFiatFromPair(pair.pair)
      const coin = getCoinFromPair(pair.pair)
      const amount =
        fix === 'FIAT'
          ? convertStandardToBase('FIAT', values.amount)
          : convertStandardToBase(coin, values.amount)
      const inputCurrency = orderType === OrderType.BUY ? fiat : coin
      const outputCurrency = orderType === OrderType.BUY ? coin : fiat
      const input = { amount, symbol: inputCurrency }
      const output = { amount, symbol: outputCurrency }

      // used for sell only now, eventually buy as well
      // TODO: use swap2 quote for buy AND sell
      if (orderType === OrderType.SELL) {
        const from = S.getSwapAccount(yield select())
        const quote = S.getSellQuote(yield select()).getOrFail(BS_ERROR.NO_QUOTE)
        if (!from) throw new Error(BS_ERROR.NO_ACCOUNT)

        const direction = getDirection(from)
        const cryptoAmt =
          fix === 'CRYPTO'
            ? amount
            : convertStandardToBase(
                from.coin,
                getQuote(pair.pair, convertStandardToBase('FIAT', quote.rate), fix, amount)
              )
        const refundAddr =
          direction === 'FROM_USERKEY'
            ? yield call(selectReceiveAddress, from, networks)
            : undefined
        const sellOrder: SwapOrderType = yield call(
          api.createSwapOrder,
          direction,
          quote.quote.id,
          cryptoAmt,
          getFiatFromPair(pair.pair),
          undefined,
          refundAddr
        )
        // on chain
        if (direction === 'FROM_USERKEY') {
          const paymentR = S.getPayment(yield select())
          // @ts-ignore
          const payment = paymentGetOrElse(from.coin, paymentR)
          try {
            yield call(buildAndPublishPayment, payment.coin, payment, sellOrder.kind.depositAddress)
            yield call(api.updateSwapOrder, sellOrder.id, 'DEPOSIT_SENT')
          } catch (e) {
            yield call(api.updateSwapOrder, sellOrder.id, 'CANCEL')
            throw e
          }
        }
        yield put(
          A.setStep({
            sellOrder,
            step: 'SELL_ORDER_SUMMARY'
          })
        )
        yield put(actions.form.stopSubmit(FORM_BS_PREVIEW_SELL))
        yield put(actions.components.refresh.refreshClicked())
        return yield put(actions.components.swap.fetchTrades())
      }

      if (!paymentType) throw new Error(BS_ERROR.NO_PAYMENT_TYPE)
      if (isFlexiblePricingModel) {
        // FIXME: this temporarily enables users to purchase min amounts of crypto with the enter amount fix set to CRYPTO
        // remove this section when backend updates the flexiblePricing APIs to handle crypto amounts
        const decimals = Currencies[fiat].units[fiat as UnitType].decimal_digits
        const standardRate = convertBaseToStandard(coin, buyQuote.rate)
        const standardInputAmount = convertBaseToStandard(coin, input.amount)
        const inputAmount = new BigNumber(standardInputAmount || '0')
          .dividedBy(standardRate)
          .toFixed(decimals)
        if (orderType === OrderType.BUY && fix === 'CRYPTO') {
          // @ts-ignore
          delete output.amount
          input.amount = convertStandardToBase('FIAT', inputAmount) // ex. 5 -> 500
        }
        if (orderType === OrderType.BUY && fix === 'FIAT') {
          // @ts-ignore
          delete output.amount
        }
      } else {
        if (orderType === OrderType.BUY && fix === 'CRYPTO') {
          // @ts-ignore
          delete input.amount
        }
        if (orderType === OrderType.BUY && fix === 'FIAT') {
          // @ts-ignore
          delete output.amount
        }
      }

      let buyOrder: BSOrderType
      let oldBuyOrder: BSOrderType | undefined

      if (mobilePaymentMethod === MobilePaymentType.APPLE_PAY) {
        const applePayInfo: ApplePayInfoType = yield call(api.getApplePayInfo, fiat)

        yield put(A.setApplePayInfo(applePayInfo))
      }

      if (mobilePaymentMethod === MobilePaymentType.GOOGLE_PAY) {
        const googlePayInfo: GooglePayInfoType = yield call(api.getGooglePayInfo, fiat)

        yield put(A.setGooglePayInfo(googlePayInfo))
      }

      yield put(A.createOrderLoading())

      // This code is handles refreshing the buy order when the user sits on
      // the order confirmation screen.
      if (isFlexiblePricingModel) {
        while (true) {
          // non gold users can only make one order at a time so we need to cancel the old one
          if (oldBuyOrder) {
            yield call(api.cancelBSOrder, oldBuyOrder)
          }
          // get the current order, if any
          const currentBuyQuote = S.getBuyQuote(yield select()).getOrFail(BS_ERROR.NO_QUOTE)

          buyOrder = yield call(
            api.createBSOrder,
            pair.pair,
            orderType,
            true,
            input,
            output,
            paymentType,
            period,
            paymentMethodId,
            currentBuyQuote.quote.quoteId
          )

          // first time creating the order when the user submits the enter amount form
          if (!oldBuyOrder) {
            yield put(actions.form.stopSubmit(FORM_BS_CHECKOUT))
          }

          yield put(A.fetchOrders())
          yield put(A.createOrderSuccess(buyOrder))

          yield put(A.setStep({ step: 'CHECKOUT_CONFIRM' }))

          oldBuyOrder = buyOrder

          // pause the while loop here until if/when the quote expires again, then refresh the order
          yield take(A.fetchBuyQuoteSuccess)
          // need to get curren step and break if not checkout confirm
          // usually happens when the user goes back to the enter amount form
          const currentStep = S.getStep(yield select())
          if (currentStep !== 'CHECKOUT_CONFIRM') {
            break
          }
        }
      } else {
        buyOrder = yield call(
          api.createBSOrder,
          pair.pair,
          orderType,
          true,
          input,
          output,
          paymentType,
          period,
          paymentMethodId,
          buyQuote?.quote?.quoteId
        )

        yield put(actions.form.stopSubmit(FORM_BS_CHECKOUT))
        yield put(A.fetchOrders())
        yield put(A.createOrderSuccess(buyOrder))

        yield put(A.setStep({ step: 'CHECKOUT_CONFIRM' }))
      }
    } catch (e) {
      const error: number | string = errorHandlerCode(e)

      const skipErrorDisplayList = [BS_ERROR.NO_AMOUNT, BS_ERROR.NO_AMOUNT]
      // After CC has been activated we try to create an order
      // If order creation fails go back to ENTER_AMOUNT step
      // Wait for the form to be INITIALIZED and display err
      const step = S.getStep(yield select())
      if (step !== 'ENTER_AMOUNT') {
        const pair = S.getBSPair(yield select())
        const method = S.getBSPaymentMethod(yield select())
        const from = S.getSwapAccount(yield select())
        // If user doesn't enter amount into checkout
        // they are redirected back to checkout screen
        // ensures newly linked bank account is fetched
        yield call(fetchBankTransferAccounts)
        if (pair) {
          yield put(
            A.setStep({
              cryptoCurrency: getCoinFromPair(pair.pair),
              fiatCurrency: getFiatFromPair(pair.pair),
              method,
              orderType: values?.orderType,
              pair,
              step: 'ENTER_AMOUNT',
              swapAccount: from
            })
          )
          yield take(A.initializeCheckout.type)
          yield delay(3000)
          yield put(actions.form.startSubmit(FORM_BS_CHECKOUT))
        }
      }

      if (!skipErrorDisplayList.includes(error as BS_ERROR)) {
        yield put(A.createOrderFailure(e))
      }

      if (values?.orderType === OrderType.SELL) {
        yield put(actions.form.stopSubmit(FORM_BS_PREVIEW_SELL, { _error: error }))
      }

      // Check if we want to display the error to the user or not.
      yield put(
        actions.form.stopSubmit(FORM_BS_CHECKOUT, {
          _error: skipErrorDisplayList.includes(error as BS_ERROR) ? undefined : error
        })
      )
    }
  }

  const checkAuthUrl = function* (orderId) {
    const order: ReturnType<typeof api.getBSOrder> = yield call(api.getBSOrder, orderId)
    if (order.attributes?.authorisationUrl || order.state === 'FAILED') {
      return order
    }
    throw new Error(BS_ERROR.RETRYING_TO_GET_AUTH_URL)
  }

  const orderConfirmCheck = function* (orderId) {
    const order: ReturnType<typeof api.getBSOrder> = yield call(api.getBSOrder, orderId)

    if (order.state === 'FINISHED' || order.state === 'FAILED' || order.state === 'CANCELED') {
      return order
    }

    throw new Error(BS_ERROR.ORDER_VERIFICATION_TIMED_OUT)
  }

  const confirmOrderPoll = function* ({ payload }: ReturnType<typeof A.confirmOrderPoll>) {
    const { RETRY_AMOUNT, SECONDS } = POLLING
    const confirmedOrder = yield retry(RETRY_AMOUNT, SECONDS * 1000, orderConfirmCheck, payload.id)
    yield put(actions.form.stopSubmit(FORM_BS_CHECKOUT_CONFIRM))
    yield put(A.confirmOrderSuccess(confirmedOrder))
    yield put(A.setStep({ step: 'ORDER_SUMMARY' }))
    yield put(A.fetchOrders())
  }

  const confirmOrder = function* ({ payload }: ReturnType<typeof A.confirmOrder>) {
    const { mobilePaymentMethod, paymentMethodId } = payload

    let { order } = payload

    try {
      if (!order) throw new Error(BS_ERROR.NO_ORDER_EXISTS)

      yield put(actions.form.startSubmit(FORM_BS_CHECKOUT_CONFIRM))

      const account = selectors.components.brokerage.getAccount(yield select())

      const domainsR = selectors.core.walletOptions.getDomains(yield select())

      const domains = domainsR.getOrElse({
        comRoot: 'https://www.blockchain.com',
        walletHelper: 'https://wallet-helper.blockchain.com'
      } as WalletOptionsType['domains'])

      let attributes

      const paymentSuccessLink = `${domains.walletHelper}/wallet-helper/3ds-payment-success/#/`

      if (
        order.paymentType === BSPaymentTypes.PAYMENT_CARD ||
        order.paymentType === BSPaymentTypes.USER_CARD
      ) {
        attributes = {
          everypay: {
            customerUrl: paymentSuccessLink
          },
          redirectURL: paymentSuccessLink
        }
      } else if (account?.partner === BankPartners.YAPILY) {
        attributes = { callback: `${domains.comRoot}/brokerage-link-success` }
      }

      if (mobilePaymentMethod) {
        if (mobilePaymentMethod === MobilePaymentType.APPLE_PAY) {
          const applePayInfo = selectors.components.buySell.getApplePayInfo(yield select())

          if (!applePayInfo) {
            throw new Error(BS_ERROR.APPLE_PAY_INFO_NOT_FOUND)
          }

          const merchantCapabilities: ApplePayJS.ApplePayMerchantCapability[] = [
            'supports3DS',
            'supportsDebit'
          ]

          if (applePayInfo.allowCreditCards) {
            merchantCapabilities.push('supportsCredit')
          }

          // inputAmount is in cents, but amount has to be in decimals
          const amount = parseInt(order.inputQuantity, 10) / 100

          const paymentRequest: ApplePayJS.ApplePayPaymentRequest = {
            countryCode: applePayInfo.merchantBankCountryCode,
            currencyCode: order.inputCurrency,
            merchantCapabilities,
            supportedNetworks: ['visa', 'masterCard'],
            total: { amount: `${amount}`, label: 'Blockchain.com' }
          }

          const token = yield call(generateApplePayToken, {
            applePayInfo,
            paymentRequest
          })

          attributes = {
            applePayPaymentToken: token,
            everypay: {
              customerUrl: paymentSuccessLink
            },
            redirectURL: paymentSuccessLink
          }
        }

        if (mobilePaymentMethod === MobilePaymentType.GOOGLE_PAY) {
          const googlePayInfo = selectors.components.buySell.getGooglePayInfo(yield select())

          if (!googlePayInfo) {
            throw new Error(BS_ERROR.GOOGLE_PAY_INFO_NOT_FOUND)
          }

          const allowedCardNetworks: google.payments.api.CardNetwork[] = ['MASTERCARD', 'VISA']

          const allowedAuthMethods: google.payments.api.CardAuthMethod[] = [
            'PAN_ONLY',
            'CRYPTOGRAM_3DS'
          ]

          // inputAmount is in cents, but amount has to be in decimals
          const amount = parseInt(order.inputQuantity, 10) / 100

          let parameters: google.payments.api.PaymentGatewayTokenizationParameters | null = null

          try {
            parameters = JSON.parse(googlePayInfo.googlePayParameters)
          } catch (e) {
            throw new Error(BS_ERROR.GOOGLE_PAY_PARAMETERS_MALFORMED)
          }

          if (!parameters) {
            throw new Error(BS_ERROR.GOOGLE_PAY_PARAMETERS_NOT_FOUND)
          }

          const paymentDataRequest = {
            allowedPaymentMethods: [
              {
                parameters: {
                  allowedAuthMethods,
                  allowedCardNetworks,
                  billingAddressParameters: {
                    format: 'FULL' as const
                  },
                  billingAddressRequired: false
                },
                tokenizationSpecification: {
                  parameters,
                  type: 'PAYMENT_GATEWAY' as const
                },
                type: 'CARD' as const
              }
            ],
            apiVersion: 2,
            apiVersionMinor: 0,
            merchantInfo: {
              merchantId: GOOGLE_PAY_MERCHANT_ID,
              merchantName: 'Blockchain.com'
            },
            shippingAddressRequired: false,
            transactionInfo: {
              countryCode: googlePayInfo.merchantBankCountry,
              currencyCode: order.inputCurrency,
              totalPrice: `${amount}`,
              totalPriceStatus: 'FINAL' as const
            }
          }

          const token = yield call(generateGooglePayToken, paymentDataRequest)

          attributes = {
            everypay: {
              customerUrl: paymentSuccessLink
            },
            googlePayPayload: token,
            redirectURL: paymentSuccessLink
          }
        }
      }

      const isFlexiblePricingModel = (yield select(
        selectors.core.walletOptions.getFlexiblePricingModel
      )).getOrElse(false)

      if (isFlexiblePricingModel) {
        const freshOrder = S.getBSOrder(yield select()).getOrFail(BS_ERROR.ORDER_NOT_FOUND)

        if (freshOrder.inputQuantity !== order.inputQuantity) {
          throw new Error(BS_ERROR.ORDER_VALUE_CHANGED)
        }

        order = freshOrder
      }

      yield put(A.confirmOrderLoading())

      // TODO: Change behavior changing a flag to make this async when backend is ready
      // then we will have to poll this order until it's confirmed and has the 3DS url
      const confirmedOrder: BSOrderType = yield call(
        api.confirmBSOrder,
        order,
        attributes,
        paymentMethodId
      )

      // TODO add loading state

      // TODO add polling for order

      // TODO pass confirmed order here

      // Check if the user has a yapily account and if they're submitting a bank transfer order
      if (
        order.paymentType === BSPaymentTypes.BANK_TRANSFER &&
        account?.partner === BankPartners.YAPILY
      ) {
        const { RETRY_AMOUNT, SECONDS } = POLLING
        // for OB the authorizationUrl isn't in the initial response to confirm
        // order. We need to poll the order for it.
        yield put(A.setStep({ step: 'LOADING' }))
        const order = yield retry(RETRY_AMOUNT, SECONDS * 1000, checkAuthUrl, confirmedOrder.id)
        // Refresh the tx list in the modal background
        yield put(A.fetchOrders())

        yield put(A.confirmOrderSuccess(order))

        yield put(A.setStep({ step: 'OPEN_BANKING_CONNECT' }))
        // Now we need to poll for the order success
        return yield call(confirmOrderPoll, A.confirmOrderPoll(confirmedOrder))
      }

      // Refresh recurring buy list to check for new pending RBs for next step
      yield put(actions.components.recurringBuy.fetchRegisteredList())

      yield put(actions.form.stopSubmit(FORM_BS_CHECKOUT_CONFIRM))

      if (confirmedOrder.paymentType === BSPaymentTypes.BANK_TRANSFER) {
        yield put(A.confirmOrderSuccess(confirmedOrder))

        yield put(A.setStep({ step: 'ORDER_SUMMARY' }))
      } else if (
        confirmedOrder.attributes?.everypay?.paymentState === 'SETTLED' ||
        confirmedOrder.attributes?.cardProvider?.paymentState === 'SETTLED'
      ) {
        yield put(A.confirmOrderSuccess(confirmedOrder))

        yield put(A.setStep({ step: 'ORDER_SUMMARY' }))
      } else if (
        confirmedOrder.attributes?.everypay ||
        (confirmedOrder.attributes?.cardProvider?.cardAcquirerName === 'EVERYPAY' &&
          confirmedOrder.attributes?.cardProvider?.paymentState === 'WAITING_FOR_3DS_RESPONSE')
      ) {
        yield put(A.confirmOrderSuccess(confirmedOrder))

        yield put(A.setStep({ step: '3DS_HANDLER_EVERYPAY' }))
      } else if (
        confirmedOrder.attributes?.cardProvider?.cardAcquirerName === 'STRIPE' &&
        confirmedOrder.attributes?.cardProvider?.paymentState === 'WAITING_FOR_3DS_RESPONSE'
      ) {
        yield put(A.confirmOrderSuccess(confirmedOrder))

        yield put(A.setStep({ step: '3DS_HANDLER_STRIPE' }))
      } else if (
        confirmedOrder.attributes?.cardProvider?.cardAcquirerName === 'CHECKOUTDOTCOM' &&
        confirmedOrder.attributes?.cardProvider?.paymentState === 'WAITING_FOR_3DS_RESPONSE'
      ) {
        yield put(A.confirmOrderSuccess(confirmedOrder))

        yield put(A.setStep({ step: '3DS_HANDLER_CHECKOUTDOTCOM' }))
      } else {
        throw new Error(BS_ERROR.UNHANDLED_PAYMENT_STATE)
      }

      yield put(A.fetchOrders())
    } catch (e) {
      const error = errorHandlerCode(e)

      yield put(A.setStep({ step: 'CHECKOUT_CONFIRM' }))

      yield put(A.confirmOrderFailure(error))
    }
  }

  const confirmBSFundsOrder = function* () {
    try {
      const order = S.getBSOrder(yield select())
      if (!order) throw new Error(BS_ERROR.NO_ORDER_EXISTS)
      yield put(actions.form.startSubmit(FORM_BS_CHECKOUT_CONFIRM))
      // TODO fix this type
      const confirmedOrder: BSOrderType = yield call(api.confirmBSOrder, order as any)
      yield put(actions.form.stopSubmit(FORM_BS_CHECKOUT_CONFIRM))
      yield put(A.fetchOrders())
      yield put(A.confirmOrderSuccess(confirmedOrder))

      yield put(A.setStep({ step: 'ORDER_SUMMARY' }))
    } catch (e) {
      // TODO: adding error handling with different error types and messages
      const error = errorHandler(e)
      yield put(actions.form.stopSubmit(FORM_BS_CHECKOUT_CONFIRM, { _error: error }))
    }
  }

  const deleteBSCard = function* ({ payload }: ReturnType<typeof A.deleteCard>) {
    try {
      if (!payload) return
      yield put(actions.form.startSubmit(FORM_BS_CHECKOUT_CONFIRM))
      yield call(api.deleteSavedAccount, payload, 'cards')
      yield put(A.fetchCards(true))
      yield take([A.fetchCardsSuccess.type, A.fetchCardsFailure.type])
      yield put(actions.form.stopSubmit(FORM_BS_CHECKOUT_CONFIRM))
      yield put(actions.alerts.displaySuccess('Card removed.'))
    } catch (e) {
      // TODO: adding error handling with different error types and messages
      const error = errorHandler(e)
      yield put(actions.form.stopSubmit(FORM_BS_CHECKOUT_CONFIRM, { _error: error }))
      yield put(actions.alerts.displayError('Error removing card.'))
    }
  }

  const fetchBSBalances = function* ({ payload }: ReturnType<typeof A.fetchBalance>) {
    const { currency, skipLoading } = payload
    try {
      if (!skipLoading) yield put(A.fetchBalanceLoading())
      const balances: ReturnType<typeof api.getBSBalances> = yield call(api.getBSBalances, currency)
      yield put(A.fetchBalanceSuccess(balances))
    } catch (e) {
      yield put(A.fetchBalanceSuccess(DEFAULT_BS_BALANCES))
    }
  }

  const createBSCard = function* ({ payload }: ReturnType<typeof A.createCard>) {
    try {
      yield put(A.createCardLoading())
      const currency = S.getFiatCurrency(yield select())
      if (!currency) throw new Error(BS_ERROR.NO_FIAT_CURRENCY)

      const userDataR = selectors.modules.profile.getUserData(yield select())
      const billingAddressForm: T.BSBillingAddressFormValuesType | undefined = yield select(
        selectors.form.getFormValues(FORMS_BS_BILLING_ADDRESS)
      )

      const userData = userDataR.getOrFail(BS_ERROR.NO_USER_DATA)
      const address = billingAddressForm || userData.address

      if (!address) throw new Error(BS_ERROR.NO_ADDRESS)

      const card = yield call(api.createBSCard, {
        address,
        currency,
        email: userData.email,
        paymentMethodTokens: payload
      })

      yield put(A.createCardSuccess(card))
    } catch (e) {
      const error = errorHandlerCode(e)

      yield put(A.createCardFailure(error))
    }
  }

  const fetchSDDVerified = function* () {
    try {
      const isSddVerified = S.getSddVerified(yield select()).getOrElse({
        verified: false
      })
      const { nabuUserId } = (yield select(
        selectors.core.kvStore.unifiedCredentials.getUnifiedOrLegacyNabuEntry
      )).getOrElse({ nabuUserId: null })

      if (!isSddVerified.verified && nabuUserId) {
        yield put(A.fetchSDDVerifiedLoading())
        const sddEligible = yield call(api.fetchSDDVerified)
        yield put(A.fetchSDDVerifiedSuccess(sddEligible))
      }
    } catch (e) {
      const { code: network_error_code, message: network_error_description } =
        errorCodeAndMessage(e)
      const error: PartialClientErrorProperties = {
        network_endpoint: '/sdd/verified',
        network_error_code,
        network_error_description,
        source: 'NABU'
      }
      yield put(A.fetchSDDVerifiedFailure(error))
    }
  }

  const fetchBSCards = function* ({ payload }: ReturnType<typeof A.fetchCards>) {
    let useNewPaymentProviders = false
    try {
      yield call(waitForUserData)

      yield call(fetchSDDVerified)
      const isUserTier2 = yield call(isTier2)
      const sddVerified = S.isUserSddVerified(yield select()).getOrElse(false)
      const loadCards = isUserTier2 || sddVerified

      if (!loadCards) return yield put(A.fetchCardsSuccess([]))
      if (!payload) yield put(A.fetchCardsLoading())

      useNewPaymentProviders = (yield select(
        selectors.core.walletOptions.getUseNewPaymentProviders
      )).getOrElse(false)

      const cards = yield call(api.getBSCards, useNewPaymentProviders)
      yield put(A.fetchCardsSuccess(cards))
    } catch (e) {
      const { code: network_error_code, message: network_error_description } =
        errorCodeAndMessage(e)
      const error: PartialClientErrorProperties = {
        network_endpoint: `/payments/cards?cardProvider=${useNewPaymentProviders}`,
        network_error_code,
        network_error_description,
        source: 'NABU'
      }
      yield put(A.fetchCardsFailure(error))
    }
  }

  const fetchFiatEligible = function* ({ payload }: ReturnType<typeof A.fetchFiatEligible>) {
    try {
      let fiatEligible: FiatEligibleType
      yield put(A.fetchFiatEligibleLoading())
      // If user is not tier 2 fake eligible check to allow KYC
      if (!(yield call(isTier2))) {
        fiatEligible = {
          buySellTradingEligible: true,
          eligible: true,
          maxPendingConfirmationSimpleBuyTrades: 1,
          maxPendingDepositSimpleBuyTrades: 1,
          paymentAccountEligible: true,
          pendingConfirmationSimpleBuyTrades: 0,
          pendingDepositSimpleBuyTrades: 0,
          simpleBuyPendingTradesEligible: true,
          simpleBuyTradingEligible: true
        }
      } else {
        fiatEligible = yield call(api.getBSFiatEligible, payload)
      }
      yield put(A.fetchFiatEligibleSuccess(fiatEligible))
    } catch (e) {
      const { code: network_error_code, message: network_error_description } =
        errorCodeAndMessage(e)
      const error: PartialClientErrorProperties = {
        network_endpoint: '/simple-buy/eligible',
        network_error_code,
        network_error_description,
        source: 'NABU'
      }
      yield put(A.fetchFiatEligibleFailure(error))
    }
  }

  const fetchSDDEligible = function* () {
    try {
      yield put(A.fetchSDDEligibleLoading())
      // check if user is already tier 2
      if (!(yield call(isTier2))) {
        // user not tier 2, call for sdd eligibility
        const sddEligible = yield call(api.fetchSDDEligible)
        yield put(A.fetchSDDEligibleSuccess(sddEligible))
      } else {
        // user is already tier 2, manually set as ineligible
        yield put(
          A.fetchSDDEligibleSuccess({
            eligible: false,
            ineligibilityReason: 'KYC_TIER',
            tier: 2
          })
        )
      }
    } catch (e) {
      const { code: network_error_code, message: network_error_description } =
        errorCodeAndMessage(e)
      const error: PartialClientErrorProperties = {
        network_endpoint: '/sdd/eligible',
        network_error_code,
        network_error_description,
        source: 'NABU'
      }
      yield put(A.fetchSDDEligibleFailure(error))
    }
  }

  const fetchBSOrders = function* ({ payload }: ReturnType<typeof A.fetchOrders>) {
    try {
      yield call(waitForUserData)
      if (!payload) yield put(A.fetchOrdersLoading())
      const orders = yield call(api.getBSOrders, {})
      yield put(A.fetchOrdersSuccess(orders))
      yield put(actions.components.brokerage.fetchBankTransferAccounts())
    } catch (e) {
      if (!(yield call(isTier2))) return yield put(A.fetchOrdersSuccess([]))

      const { code: network_error_code, message: network_error_description } =
        errorCodeAndMessage(e)
      const error: PartialClientErrorProperties = {
        network_endpoint: '/simple-buy/trades',
        network_error_code,
        network_error_description,
        source: 'NABU'
      }
      yield put(A.fetchOrdersFailure(error))
    }
  }

  const fetchPairs = function* ({ payload }: ReturnType<typeof A.fetchPairs>) {
    const { coin, currency } = payload
    try {
      yield put(A.fetchPairsLoading())
      const { pairs }: ReturnType<typeof api.getBSPairs> = yield call(api.getBSPairs, currency)
      const filteredPairs = pairs.filter((pair) => {
        return (
          window.coins[getCoinFromPair(pair.pair)] &&
          window.coins[getCoinFromPair(pair.pair)].coinfig.type.name !== 'FIAT'
        )
      })
      yield put(A.fetchPairsSuccess({ coin, pairs: filteredPairs }))
    } catch (e) {
      const { code: network_error_code, message: network_error_description } =
        errorCodeAndMessage(e)
      const error: PartialClientErrorProperties = {
        network_endpoint: '/simple-buy/pairs',
        network_error_code,
        network_error_description,
        source: 'NABU'
      }
      yield put(A.fetchPairsFailure(error))
    }
  }

  const fetchPaymentAccount = function* () {
    try {
      yield put(A.fetchPaymentAccountLoading())
      const fiatCurrency = S.getFiatCurrency(yield select())
      if (!fiatCurrency) throw new Error(BS_ERROR.NO_FIAT_CURRENCY)
      const account: BSAccountType = yield call(api.getBSPaymentAccount, fiatCurrency)
      yield put(A.fetchPaymentAccountSuccess(account))
    } catch (e) {
      // TODO: adding error handling with different error types and messages
      const error = errorHandler(e)
      yield put(A.fetchPaymentAccountFailure(error))
    }
  }

  const fetchPaymentMethods = function* ({ payload }: ReturnType<typeof A.fetchPaymentMethods>) {
    try {
      yield call(waitForUserData)
      const userData = selectors.modules.profile.getUserData(yield select()).getOrElse({
        state: 'NONE'
      } as UserDataType)

      // 🚨DO NOT create the user if no currency is passed
      if (userData.state === 'NONE' && !payload) {
        return yield put(A.fetchPaymentMethodsSuccess(DEFAULT_BS_METHODS))
      }

      // Only show Loading if not Success or 0 methods
      const sbMethodsR = S.getBSPaymentMethods(yield select())
      const sbMethods = sbMethodsR.getOrElse(DEFAULT_BS_METHODS)
      if (!Remote.Success.is(sbMethodsR) || !sbMethods.methods.length)
        yield put(A.fetchPaymentMethodsLoading())

      // 🚨Create the user if you have a currency
      yield call(createUser)

      // If no currency fallback to sb fiat currency or wallet
      const fallbackFiatCurrency =
        S.getFiatCurrency(yield select()) ||
        (yield select(selectors.core.settings.getCurrency)).getOrElse('USD')

      const userSDDTierR = S.getUserSddEligibleTier(yield select())
      if (!Remote.Success.is(userSDDTierR)) {
        yield call(fetchSDDEligible)
      }
      const state = yield select()
      const currentUserTier = selectors.modules.profile.getCurrentTier(state)
      const userSDDEligibleTier = S.getUserSddEligibleTier(state).getOrElse(1)
      // only fetch non-eligible payment methods if user is not tier 2
      const includeNonEligibleMethods = currentUserTier === 2
      // if user is SDD tier 3 eligible, fetch limits for tier 3
      // else let endpoint return default current tier limits for current tier of user
      // double check if user is tier 2 and in case user is ignore this property
      const includeTierLimits =
        userSDDEligibleTier === SDD_TIER && currentUserTier !== 2 ? SDD_TIER : undefined

      let paymentMethods = yield call(
        api.getBSPaymentMethods,
        payload || fallbackFiatCurrency,
        includeNonEligibleMethods,
        includeTierLimits
      )

      // 🚨👋 temporarily remove ACH from user payment methods if they are not t2
      // t2 users who are invited to ACH beta will still get method since the API will
      // return that method if they are actually eligible
      if (currentUserTier !== 2) {
        paymentMethods = paymentMethods.filter(
          (method) => method.type !== BSPaymentTypes.BANK_TRANSFER
        )
      }
      yield put(
        A.fetchPaymentMethodsSuccess({
          currency: payload || fallbackFiatCurrency,
          methods: paymentMethods
        })
      )
    } catch (e) {
      // TODO: adding error handling with different error types and messages
      const error = errorHandler(e)
      yield put(A.fetchPaymentMethodsFailure(error))
    }
  }

  const fetchBSQuote = function* ({ payload }: ReturnType<typeof A.fetchQuote>) {
    // this is actually fetchQuote() action
    try {
      const { amount, orderType, pair } = payload
      yield put(A.fetchQuoteLoading())
      const quote: BSQuoteType = yield call(api.getBSQuote, pair, orderType, amount)
      yield put(A.fetchQuoteSuccess(quote))
    } catch (e) {
      // TODO: adding error handling with different error types and messages
      const error = errorHandler(e)
      yield put(A.fetchQuoteFailure(error))
    }
  }

  const fetchBuyQuote = function* ({ payload }: ReturnType<typeof A.fetchBuyQuote>) {
    while (true) {
      try {
        const { amount, pair, paymentMethod, paymentMethodId } = payload
        const pairReversed = reversePair(pair)

        // paymentMethodId is required when profile=SIMPLEBUY and paymentMethod=BANK_TRANSFER
        const buyQuotePaymentMethodId =
          paymentMethod === BSPaymentTypes.BANK_TRANSFER ? paymentMethodId : undefined

        const quote: ReturnType<typeof api.getBuyQuote> = yield call(
          api.getBuyQuote,
          pairReversed,
          'SIMPLEBUY',
          amount,
          paymentMethod,
          buyQuotePaymentMethodId
        )

        yield put(
          A.fetchBuyQuoteSuccess({
            fee: quote.feeDetails.fee.toString(),
            pair,
            quote,
            rate: parseInt(quote.price)
          })
        )
        const refresh = Math.abs(
          differenceInMilliseconds(new Date(quote.quoteExpiresAt), addSeconds(new Date(), 10))
        )
        yield delay(refresh)
      } catch (e) {
        const { code: network_error_code, message: network_error_description } =
          errorCodeAndMessage(e)
        const error: PartialClientErrorProperties = {
          network_endpoint: '/brokerage/quote',
          network_error_code,
          network_error_description,
          source: 'NABU'
        }
        yield put(A.fetchBuyQuoteFailure(error))
        // stop fetching new quote until user does retry action
        yield put(A.stopPollBuyQuote())
      }
    }
  }

  // new sell quote fetch
  // Copied from swap and hopefully eventually
  // shared between the 2 UIs and 3 methods (buy, sell, swap)

  // used for sell only now, eventually buy as well
  // TODO: use swap2 quote for buy AND sell
  const fetchSellQuote = function* ({ payload }: ReturnType<typeof A.fetchSellQuote>) {
    while (true) {
      try {
        yield put(A.fetchSellQuoteLoading())

        const { pair } = payload
        const direction = getDirection(payload.account)
        const quote: ReturnType<typeof api.getSwapQuote> = yield call(
          api.getSwapQuote,
          pair,
          direction
        )
        const rate = getRate(
          quote.quote.priceTiers,
          getOutputFromPair(pair),
          new BigNumber(convertStandardToBase(payload.account.coin, 1)),
          true
        )

        yield put(A.fetchSellQuoteSuccess({ quote, rate }))
        const refresh = Math.abs(
          differenceInMilliseconds(new Date(quote.expiresAt), addSeconds(new Date(), 10))
        )
        yield delay(refresh)
      } catch (e) {
        const error = errorHandler(e)
        yield put(A.fetchSellQuoteFailure(error))
        yield delay(FALLBACK_DELAY)
        yield put(A.startPollSellQuote(payload))
      }
    }
  }

  const formChanged = function* (action) {
    try {
      if (action.meta.form !== FORM_BS_CHECKOUT) return
      if (action.meta.field !== 'amount') return
      const formValues = selectors.form.getFormValues(FORM_BS_CHECKOUT)(
        yield select()
      ) as T.BSCheckoutFormValuesType
      const account = S.getSwapAccount(yield select())
      const pair = S.getBSPair(yield select())

      if (!formValues) return
      if (!account) return
      if (!pair) return

      const paymentR = S.getPayment(yield select())
      const quoteR = S.getSellQuote(yield select())
      const quote = quoteR.getOrFail(BS_ERROR.NO_QUOTE)

      const amt = getQuote(pair.pair, quote.rate, formValues.fix, formValues.amount)

      const cryptoAmt = formValues.fix === 'CRYPTO' ? formValues.amount : amt
      yield put(actions.form.change(FORM_BS_CHECKOUT, 'cryptoAmount', cryptoAmt))
      if (account.type === SwapBaseCounterTypes.CUSTODIAL) return
      // @ts-ignore
      let payment = paymentGetOrElse(account.coin, paymentR)
      const paymentAmount = generateProvisionalPaymentAmount(account.coin, Number(cryptoAmt))
      payment = yield payment.amount(paymentAmount)
      payment = yield payment.build()
      yield put(A.updatePaymentSuccess(payment.value()))
    } catch (e) {
      // eslint-disable-next-line
      console.log(e)
    }
  }

  const handleBSDepositFiatClick = function* ({
    payload
  }: ReturnType<typeof A.handleDepositFiatClick>) {
    const { coin } = payload

    yield call(waitForUserData)
    const isUserTier2 = yield call(isTier2)

    if (!isUserTier2) {
      yield put(A.showModal({ origin: 'EmptyFeed' }))
      yield put(
        A.setStep({
          step: 'KYC_REQUIRED'
        })
      )
    } else {
      yield put(A.showModal({ origin: 'EmptyFeed' }))

      // wait for modal
      yield delay(500)
      yield put(
        A.setStep({
          displayBack: false,
          fiatCurrency: coin as FiatType,
          step: 'BANK_WIRE_DETAILS'
        })
      )
    }
  }

  const handleBuyMaxAmountClick = function* ({
    payload
  }: ReturnType<typeof A.handleBuyMaxAmountClick>) {
    const { amount, coin } = payload
    const standardAmt = convertBaseToStandard(coin, amount)

    yield put(actions.form.change(FORM_BS_CHECKOUT, 'amount', standardAmt))
  }

  const handleBuyMinAmountClick = function* ({
    payload
  }: ReturnType<typeof A.handleBuyMinAmountClick>) {
    const { amount, coin } = payload
    const standardAmt = convertBaseToStandard(coin, amount)

    yield put(actions.form.change(FORM_BS_CHECKOUT, 'amount', standardAmt))
  }

  const handleSellMaxAmountClick = function* ({
    payload
  }: ReturnType<typeof A.handleSellMaxAmountClick>) {
    const { amount, coin } = payload
    const standardAmt = convertBaseToStandard(coin, amount)

    yield put(actions.form.change(FORM_BS_CHECKOUT, 'amount', standardAmt))
  }

  const handleSellMinAmountClick = function* ({
    payload
  }: ReturnType<typeof A.handleSellMinAmountClick>) {
    const { amount, coin } = payload
    const standardAmt = convertBaseToStandard(coin, amount)

    yield put(actions.form.change(FORM_BS_CHECKOUT, 'amount', standardAmt))
  }

  const handleBSMethodChange = function* ({
    payload: { isFlow, method, mobilePaymentMethod }
  }: ReturnType<typeof A.handleMethodChange>) {
    const values: T.BSCheckoutFormValuesType = yield select(
      selectors.form.getFormValues(FORM_BS_CHECKOUT)
    )

    const cryptoCurrency = S.getCryptoCurrency(yield select()) || 'BTC'
    const originalFiatCurrency = S.getFiatCurrency(yield select())
    // At this point fiatCurrency should be set inside buy/sell flow - fallback to USD
    let fiatCurrency = S.getFiatCurrency(yield select()) || 'USD'
    // keep using buy/sell flow currency unless if funds has been selected
    if (method.type === BSPaymentTypes.FUNDS && fiatCurrency !== method.currency) {
      fiatCurrency = method.currency
    }
    const pair = S.getBSPair(yield select())
    const swapAccount = S.getSwapAccount(yield select())
    if (!pair) throw new Error(BS_ERROR.NO_PAIR_SELECTED)
    const isUserTier2 = yield call(isTier2)

    if (!isUserTier2) {
      switch (method.type) {
        // https://blockc.slack.com/archives/GT1JZ1ZN2/p1596546978351100?thread_ts=1596541628.345800&cid=GT1JZ1ZN2
        // REMOVE THIS WHEN BACKEND CAN HANDLE PENDING 'FUNDS' ORDERS
        // 👇--------------------------------------------------------
        case BSPaymentTypes.BANK_ACCOUNT:
        case BSPaymentTypes.USER_CARD:
          return yield put(
            A.setStep({
              step: 'KYC_REQUIRED'
            })
          )
        // REMOVE THIS WHEN BACKEND CAN HANDLE PENDING 'FUNDS' ORDERS
        // 👆--------------------------------------------------------
        case BSPaymentTypes.PAYMENT_CARD:
          // ADD THIS WHEN BACKEND CAN HANDLE PENDING 'FUNDS' ORDERS
          // 👇-----------------------------------------------------
          // const methodType =
          //   method.type === BSPaymentTypes.BANK_ACCOUNT ? BSPaymentTypes.FUNDS : method.type
          // return yield put(A.createBSOrder(undefined, methodType))
          // 👆------------------------------------------------------

          return yield put(A.createOrder({ paymentType: method.type }))
        default:
          return
      }
    }

    // User is Tier 2
    switch (method.type) {
      case BSPaymentTypes.BANK_ACCOUNT:
        return yield put(
          A.setStep({
            displayBack: true,
            fiatCurrency,
            step: 'BANK_WIRE_DETAILS'
          })
        )
      case BSPaymentTypes.LINK_BANK:
        yield put(
          actions.components.brokerage.showModal({
            isFlow,
            modalType: fiatCurrency === 'USD' ? 'ADD_BANK_YODLEE_MODAL' : 'ADD_BANK_YAPILY_MODAL',
            origin: BrokerageModalOriginType.ADD_BANK_BUY
          })
        )
        return yield put(
          actions.components.brokerage.setAddBankStep({
            addBankStep: AddBankStepType.ADD_BANK
          })
        )

      case BSPaymentTypes.PAYMENT_CARD:
        if (mobilePaymentMethod) {
          return yield put(
            A.setStep({
              cryptoCurrency,
              fiatCurrency,
              method,
              mobilePaymentMethod,
              orderType: values?.orderType,
              pair,
              step: 'ENTER_AMOUNT',
              swapAccount
            })
          )
        }

        return yield put(
          A.setStep({
            step: 'DETERMINE_CARD_PROVIDER'
          })
        )
      default:
        yield put(
          A.setStep({
            cryptoCurrency,
            fiatCurrency,
            method,
            orderType: values?.orderType,
            pair,
            step: 'ENTER_AMOUNT',
            swapAccount
          })
        )
    }

    // Change wallet/sb fiatCurrency if necessary
    // and fetch new pairs w/ new fiatCurrency
    // and pass along cryptoCurrency for pair swap
    if (originalFiatCurrency !== fiatCurrency) {
      yield put(actions.modules.settings.updateCurrency(method.currency, true))
      yield put(A.fetchPairs({ coin: cryptoCurrency, currency: method.currency }))
    }
  }

  const initializeBillingAddress = function* () {
    yield call(waitForUserData)
    const userDataR = selectors.modules.profile.getUserData(yield select())
    const userData = userDataR.getOrElse({} as UserDataType)
    const address = userData
      ? userData.address
      : {
          city: '',
          country: 'GB',
          line1: '',
          line2: '',
          postCode: '',
          state: ''
        }

    yield put(
      actions.form.initialize(FORMS_BS_BILLING_ADDRESS, {
        ...address
      })
    )
  }

  const initializeCheckout = function* ({ payload }: ReturnType<typeof A.initializeCheckout>) {
    const { account, amount, cryptoAmount, fix, orderType, period } = payload
    try {
      yield call(waitForUserData)
      const fiatCurrency = S.getFiatCurrency(yield select())
      if (!fiatCurrency) throw new Error(BS_ERROR.NO_FIAT_CURRENCY)
      const pair = S.getBSPair(yield select())
      if (!pair) throw new Error(BS_ERROR.NO_PAIR_SELECTED)
      // Fetch rates
      if (orderType === OrderType.BUY) {
        const isFlexiblePricingModel = (yield select(
          selectors.core.walletOptions.getFlexiblePricingModel
        )).getOrElse(false)

        if (isFlexiblePricingModel) {
          const amount = '500'

          yield put(
            A.startPollBuyQuote({
              amount,
              pair: pair.pair,
              paymentMethod: BSPaymentTypes.FUNDS
            })
          )
          yield race({
            failure: take(A.fetchBuyQuoteFailure.type),
            success: take(A.fetchBuyQuoteSuccess.type)
          })
        } else {
          yield put(A.fetchQuote({ amount: '0', orderType, pair: pair.pair }))
        }
      } else {
        if (!account) throw new Error(BS_ERROR.NO_ACCOUNT)
        yield put(A.fetchSellQuote({ account, pair: pair.pair }))
        yield put(A.startPollSellQuote({ account, pair: pair.pair }))
        yield race({
          failure: take(A.fetchSellQuoteFailure.type),
          success: take(A.fetchSellQuoteSuccess.type)
        })
        const quote = S.getSellQuote(yield select()).getOrFail(BS_ERROR.NO_QUOTE)

        if (account.type === SwapBaseCounterTypes.ACCOUNT) {
          const formValues = selectors.form.getFormValues(FORM_BS_CHECKOUT)(
            yield select()
          ) as T.BSCheckoutFormValuesType
          const payment = yield call(
            calculateProvisionalPayment,
            account,
            quote.quote,
            formValues ? formValues.cryptoAmount : 0
          )
          yield put(A.updatePaymentSuccess(payment))
        } else {
          yield put(A.updatePaymentSuccess(undefined))
        }
      }

      // Recurring Buy Feature Flag
      const isRecurringBuy = selectors.core.walletOptions
        .getFeatureFlagRecurringBuys(yield select())
        .getOrElse(false) as boolean

      yield put(
        actions.form.initialize(FORM_BS_CHECKOUT, {
          amount,
          cryptoAmount,
          fix,
          orderType,
          period: isRecurringBuy ? period : undefined
        })
      )
    } catch (e) {
      // TODO: adding error handling with different error types and messages
      const error = errorHandler(e)
      yield put(actions.logs.logErrorMessage(error))
    }
  }

  const pollBSCardErrorHandler = function* (state: BSCardStateType) {
    let error
    switch (state) {
      case 'PENDING':
        error = CARD_ERROR_CODE.PENDING_CARD_AFTER_POLL
        break
      case 'BLOCKED':
        error = CARD_ERROR_CODE.BLOCKED_CARD_AFTER_POLL
        break
      default:
        error = CARD_ERROR_CODE.LINK_CARD_FAILED
    }

    yield put(A.createCardFailure(error))
  }

  const pollBSBalances = function* () {
    const skipLoading = true

    yield put(A.fetchBalance({ skipLoading }))
  }

  const pollBSCard = function* ({ payload }: ReturnType<typeof A.pollCard>) {
    let retryAttempts = 0
    const maxRetryAttempts = 10

    let card: ReturnType<typeof api.getBSCard> = yield call(api.getBSCard, payload)
    let step = S.getStep(yield select())

    while (
      (card.state === 'CREATED' || card.state === 'PENDING') &&
      retryAttempts < maxRetryAttempts
    ) {
      card = yield call(api.getBSCard, payload)
      retryAttempts += 1
      step = S.getStep(yield select())
      if (
        step !== '3DS_HANDLER_EVERYPAY' &&
        step !== '3DS_HANDLER_STRIPE' &&
        step !== '3DS_HANDLER_CHECKOUTDOTCOM'
      ) {
        yield cancel()
      }
      yield delay(2000)
    }

    if (card.state === 'ACTIVE') {
      const skipLoading = true
      const order = S.getBSLatestPendingOrder(yield select())
      yield put(A.fetchCards(skipLoading))
      const cardMethodR = S.getMethodByType(yield select(), BSPaymentTypes.PAYMENT_CARD)

      // If the order was already created
      if (order && order.state === 'PENDING_CONFIRMATION') {
        return yield put(A.confirmOrder({ order, paymentMethodId: card.id }))
      }

      const origin = S.getOrigin(yield select())

      if (origin === 'SettingsGeneral') {
        yield put(actions.modals.closeModal('SIMPLE_BUY_MODAL'))

        yield put(actions.alerts.displaySuccess('Card Added.'))
      }

      // Sets the payment method to the newly created card in the enter amount form
      if (Remote.Success.is(cardMethodR)) {
        const method = cardMethodR.getOrFail(BS_ERROR.NO_PAYMENT_METHODS)
        const newCardMethod = {
          ...card,
          ...method,
          type: BSPaymentTypes.USER_CARD
        } as BSPaymentMethodType
        yield put(A.setMethod(newCardMethod))
      }

      return yield put(
        A.createOrder({ paymentMethodId: card.id, paymentType: BSPaymentTypes.PAYMENT_CARD })
      )
    }

    // TODO handle statuses here, on lastError somehow
    // to test you can use an email with +onlystripe on it
    // add a card with checkout and you'll receive an error on activate
    // I can get the ID from there and test getting the card, so I can see the lastError
    yield call(pollBSCardErrorHandler, card.state)

    // TODO pass this function to here, and not send to DETERMINE_CARD_PROVIDER depending on a feature flag
  }

  const pollBSOrder = function* ({ payload }: ReturnType<typeof A.pollOrder>) {
    let retryAttempts = 0
    const maxRetryAttempts = 10

    let order: ReturnType<typeof api.getBSOrder> = yield call(api.getBSOrder, payload)
    let step = S.getStep(yield select())

    while (order.state === 'PENDING_DEPOSIT' && retryAttempts < maxRetryAttempts) {
      order = yield call(api.getBSOrder, payload)
      step = S.getStep(yield select())
      retryAttempts += 1
      if (
        step !== '3DS_HANDLER_EVERYPAY' &&
        step !== '3DS_HANDLER_STRIPE' &&
        step !== '3DS_HANDLER_CHECKOUTDOTCOM'
      ) {
        yield cancel()
      }
      yield delay(2000)
    }

    yield put(A.createOrderSuccess(order))

    yield put(A.setStep({ step: 'ORDER_SUMMARY' }))
  }

  const setStepChange = function* (action: ReturnType<typeof A.setStep>) {
    if (action.type === '@EVENT.SET_BS_STEP') {
      if (action.payload.step === 'ORDER_SUMMARY') {
        yield call(pollBSBalances)
      }
    }

    if (action.payload.step === 'DETERMINE_CARD_PROVIDER') {
      const cardAcquirers: CardAcquirer[] = yield call(api.getCardAcquirers)

      const checkoutAcquirers: CardAcquirer[] = cardAcquirers.filter(
        (cardAcquirer: CardAcquirer) => cardAcquirer.cardAcquirerName === 'CHECKOUTDOTCOM'
      )

      if (checkoutAcquirers.length === 0) {
        throw new Error(BS_ERROR.CHECKOUTDOTCOM_NOT_FOUND)
      }

      const checkoutDotComAccountCodes = checkoutAcquirers.reduce((prev, curr) => {
        return [...new Set([...prev, ...curr.cardAcquirerAccountCodes])]
      }, [] as string[])

      const checkoutDotComApiKey = checkoutAcquirers[0].apiKey

      yield put(
        A.setStep({
          checkoutDotComAccountCodes,
          checkoutDotComApiKey,
          step: 'ADD_CARD_CHECKOUTDOTCOM'
        })
      )
    }
  }

  // Util function to help match payment method ID
  // to more details about the bank
  const getBankInformation = function* (order: BSOrderType) {
    yield put(actions.components.brokerage.fetchBankTransferAccounts())
    yield take(actions.components.brokerage.fetchBankTransferAccountsSuccess.type)
    const bankAccountsR = selectors.components.brokerage.getBankTransferAccounts(yield select())
    const bankAccounts = bankAccountsR.getOrElse([])
    const [bankAccount] = filter(
      (b: BankTransferAccountType) =>
        // @ts-ignore
        b.id === prop('paymentMethodId', order),
      defaultTo([])(bankAccounts)
    )

    return bankAccount
  }

  const cleanupCancellableOrders = function* () {
    const order = S.getCancelableOrder(yield select())
    if (order) {
      try {
        yield call(api.cancelBSOrder, order)
      } catch (error) {
        if (error.status !== 409) {
          throw error
        }
      }

      yield put(A.fetchOrders())
      yield take(A.fetchOrdersSuccess.type)
    }
  }

  const showModal = function* ({ payload }: ReturnType<typeof A.showModal>) {
    // When opening the buy modal if there are any existing orders that are cancellable, cancel them
    yield call(cleanupCancellableOrders)

    const { cryptoCurrency, orderType, origin, step } = payload

    let hasPendingOBOrder = false
    const latestPendingOrder = S.getBSLatestPendingOrder(yield select())

    // get current user tier
    const isUserTier2 = yield call(isTier2)

    yield put(actions.custodial.fetchProductEligibilityForUser())
    yield take([
      custodialActions.fetchProductEligibilityForUserSuccess.type,
      custodialActions.fetchProductEligibilityForUserFailure.type
    ])

    const products = selectors.custodial.getProductEligibilityForUser(yield select()).getOrElse({
      buy: { enabled: false, maxOrdersLeft: 0, reasonNotEligible: undefined },
      sell: { reasonNotEligible: undefined }
    } as ProductEligibilityForUser)

    // check is user eligible to do sell/buy
    // we skip this for gold users
    if (!isUserTier2 && !latestPendingOrder) {
      const userCanBuyMore = products.buy?.maxOrdersLeft > 0
      // prompt upgrade modal in case that user can't buy more
      // users with diff tier than 2 can't sell
      if (!userCanBuyMore || orderType === OrderType.SELL) {
        yield put(
          actions.modals.showModal(ModalName.UPGRADE_NOW_SILVER_MODAL, {
            origin: 'BuySellInit'
          })
        )
        return
      }
    }

    // show sanctions for buy
    if (products?.buy?.reasonNotEligible) {
      const message =
        products.buy.reasonNotEligible.reason !== CustodialSanctionsEnum.EU_5_SANCTION
          ? products.buy.reasonNotEligible.message
          : undefined
      yield put(
        actions.modals.showModal(ModalName.SANCTIONS_INFO_MODAL, {
          message,
          origin: 'BuySellInit'
        })
      )
      return
    }
    // show sanctions for sell
    if (products?.sell?.reasonNotEligible && orderType === OrderType.SELL) {
      const message =
        products.sell.reasonNotEligible.reason !== CustodialSanctionsEnum.EU_5_SANCTION
          ? products.sell.reasonNotEligible.message
          : undefined
      yield put(
        actions.modals.showModal(ModalName.SANCTIONS_INFO_MODAL, {
          message,
          origin: 'BuySellInit'
        })
      )
      return
    }

    // Check if there is a pending_deposit Open Banking order
    if (latestPendingOrder) {
      const bankAccount = yield call(getBankInformation, latestPendingOrder as BSOrderType)
      hasPendingOBOrder = prop('partner', bankAccount) === BankPartners.YAPILY
    }

    yield put(actions.modals.showModal('SIMPLE_BUY_MODAL', { cryptoCurrency, origin }))
    const fiatCurrency = selectors.core.settings
      .getCurrency(yield select())
      .getOrElse('USD') as FiatType

    // When user closes the QR code modal and opens it via one of the pending
    // buy buttons in the app. We need to take them to the qrcode screen and
    // poll for the order status
    if (hasPendingOBOrder && latestPendingOrder) {
      const step: T.StepActionsPayload['step'] = 'OPEN_BANKING_CONNECT'

      yield fork(confirmOrderPoll, A.confirmOrderPoll(latestPendingOrder))
      yield put(
        A.setStep({
          step
        })
      )
      // For all silver/silver+ users if they have pending transaction and they are from silver revamp
      // we want to let users to be able to approve/cancel transaction otherwise they will be blocked
    } else if (!isUserTier2 && latestPendingOrder) {
      const step: T.StepActionsPayload['step'] =
        latestPendingOrder.state === 'PENDING_CONFIRMATION' ? 'CHECKOUT_CONFIRM' : 'ORDER_SUMMARY'
      yield fork(confirmOrderPoll, A.confirmOrderPoll(latestPendingOrder))

      yield put(
        A.setStep({
          step
        })
      )
    } else if (cryptoCurrency) {
      switch (orderType) {
        case OrderType.BUY:
          yield put(
            // 🚨 SPECIAL TS-IGNORE
            // Usually ENTER_AMOUNT should require a pair but
            // here we do not require a pair. Instead we have
            // cryptoCurrency and fiatCurrency and
            // INITIALIZE_CHECKOUT will set the pair on state.
            // 🚨 SPECIAL TS-IGNORE
            // @ts-ignore
            A.setStep({
              cryptoCurrency,
              fiatCurrency,
              orderType,
              step: 'ENTER_AMOUNT'
            })
          )
          break
        case OrderType.SELL:
          yield put(
            A.setStep({
              cryptoCurrency,
              fiatCurrency,
              orderType,
              step: 'CRYPTO_SELECTION'
            })
          )
          break
        default:
          // do nothing
          break
      }
    } else {
      const originalFiatCurrency = isFiatCurrencySupported(fiatCurrency) ? undefined : fiatCurrency
      yield put(
        A.setStep({
          cryptoCurrency,
          fiatCurrency,
          originalFiatCurrency,
          step: step || 'CRYPTO_SELECTION'
        })
      )
    }
  }

  const switchFix = function* ({ payload }: ReturnType<typeof A.switchFix>) {
    yield put(actions.form.change(FORM_BS_CHECKOUT, 'fix', payload.fix))
    yield put(actions.preferences.setBSCheckoutFix(payload.orderType, payload.fix))
    const newAmount = new BigNumber(payload.amount).isGreaterThan(0) ? payload.amount : undefined
    yield put(actions.form.change(FORM_BS_CHECKOUT, 'amount', newAmount))
    yield put(actions.form.focus(FORM_BS_CHECKOUT, 'amount'))
  }

  const fetchLimits = function* ({ payload }: ReturnType<typeof A.fetchLimits>) {
    const { cryptoCurrency, currency, side } = payload
    try {
      yield put(A.fetchLimitsLoading())
      let limits
      if (cryptoCurrency && side) {
        limits = yield call(api.getBSLimits, currency, ProductTypes.SIMPLEBUY, cryptoCurrency, side)
      } else {
        limits = yield call(api.getSwapLimits, currency)
      }
      yield put(A.fetchLimitsSuccess(limits))
    } catch (e) {
      // TODO: adding error handling with different error types and messages
      const error = errorHandler(e)
      yield put(A.fetchLimitsFailure(error))
    }
  }

  const fetchCrossBorderLimits = function* ({
    payload
  }: ReturnType<typeof A.fetchCrossBorderLimits>) {
    const { currency, fromAccount, inputCurrency, outputCurrency, toAccount } = payload
    try {
      yield put(A.fetchCrossBorderLimitsLoading())
      const limitsResponse: ReturnType<typeof api.getCrossBorderTransactions> = yield call(
        api.getCrossBorderTransactions,
        inputCurrency,
        fromAccount,
        outputCurrency,
        toAccount,
        currency
      )
      yield put(A.fetchCrossBorderLimitsSuccess(limitsResponse))
    } catch (e) {
      yield put(A.fetchCrossBorderLimitsFailure(e))
    }
  }
  const fetchAccumulatedTrades = function* ({
    payload
  }: ReturnType<typeof A.fetchAccumulatedTrades>) {
    const { product } = payload
    try {
      yield put(A.fetchAccumulatedTradesLoading())
      yield call(waitForUserData)
      const accumulatedTradesResponse: ReturnType<typeof api.getAccumulatedTrades> = yield call(
        api.getAccumulatedTrades,
        product
      )
      yield put(A.fetchAccumulatedTradesSuccess(accumulatedTradesResponse.tradesAccumulated))
    } catch (e) {
      // This is a workaround while I don't find a solution for the fetchAccumulatedTradesFailure type
      const error = e as string

      yield put(A.fetchAccumulatedTradesFailure(error))
    }
  }

  const setFiatTradingCurrency = function* () {
    try {
      const state = yield select()
      const cryptoCurrency = S.getCryptoCurrency(state) || 'BTC'
      const fiatCurrency = S.getFiatCurrency(state) || 'USD'
      const orderType = S.getOrderType(state) || 'BUY'
      yield put(A.fetchPairs({ coin: cryptoCurrency, currency: fiatCurrency }))
      // wait to load new pairs
      yield take([A.fetchPairsSuccess.type, A.fetchPairsFailure.type])
      // state has been changed we need most recent pairs
      const pairs = S.getBSPairs(yield select()).getOrElse([])

      // find a pair
      const pair = pairs.filter((pair) => pair.pair === `${cryptoCurrency}-${fiatCurrency}`)[0]
      yield put(A.fetchPaymentMethods(fiatCurrency))
      // record desired currency
      const preferredCurrencyFromStorage = getPreferredCurrency()
      if (!preferredCurrencyFromStorage) {
        setPreferredCurrency(fiatCurrency as WalletFiatType)
      }
      yield put(
        A.setStep({
          cryptoCurrency,
          fiatCurrency,
          orderType,
          pair,
          step: 'ENTER_AMOUNT'
        })
      )
    } catch (e) {
      // do nothing
    }
  }

  return {
    activateBSCard,
    cancelBSOrder,
    confirmBSFundsOrder,
    confirmOrder,
    confirmOrderPoll,
    createBSCard,
    createBSOrder,
    deleteBSCard,
    fetchAccumulatedTrades,
    fetchBSBalances,
    fetchBSCards,
    fetchBSOrders,
    fetchBSQuote,
    fetchBuyQuote,
    fetchCrossBorderLimits,
    fetchFiatEligible,
    fetchLimits,
    fetchPairs,
    fetchPaymentAccount,
    fetchPaymentMethods,
    fetchSDDEligible,
    fetchSDDVerified,
    fetchSellQuote,
    formChanged,
    handleBSDepositFiatClick,
    handleBSMethodChange,
    handleBuyMaxAmountClick,
    handleBuyMinAmountClick,
    handleSellMaxAmountClick,
    handleSellMinAmountClick,
    initializeBillingAddress,
    initializeCheckout,
    pollBSBalances,
    pollBSCard,
    pollBSOrder,
    registerBSCard,
    setFiatTradingCurrency,
    setStepChange,
    showModal,
    switchFix
  }
}
