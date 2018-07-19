import PhoneNumber from 'awesome-phonenumber'
import { selectors } from 'data'
import { path, lift } from 'ramda'
import { createDeepEqualSelector } from 'services/ReselectHelper'

const {
  getPersonalData,
  getPersonalStep,
  getSmsStep,
  getEmailStep,
  getFormBusy
} = selectors.components.identityVerification

export const getData = state => ({
  personalData: getPersonalData(state),
  step: getPersonalStep(state).getOrElse(null),
  countryCode: getCountryCode(state).getOrElse('US'),
  formBusy: getFormBusy(state)
})

export const getEmailData = state => ({
  step: getEmailStep(state).getOrElse(null),
  emailVerifiedError: path(['securityCenter', 'emailVerifiedError'], state)
})

export const getSmsData = state => ({
  step: getSmsStep(state).getOrElse(null),
  mobileVerifiedError: path(['securityCenter', 'mobileVerifiedError'], state),
  countryCode: getCountryCode(state)
})

const determineCountryCode = (currentNumber, defaultCode) =>
  currentNumber ? PhoneNumber(currentNumber).getRegionCode() : defaultCode

const getCountryCode = createDeepEqualSelector(
  [
    selectors.core.settings.getSmsNumber,
    selectors.core.settings.getCountryCode
  ],
  lift(determineCountryCode)
)
