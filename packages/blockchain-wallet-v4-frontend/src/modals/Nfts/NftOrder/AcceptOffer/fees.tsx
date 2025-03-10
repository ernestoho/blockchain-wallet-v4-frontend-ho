import React, { useEffect } from 'react'
import { FormattedMessage } from 'react-intl'
import BigNumber from 'bignumber.js'

import { GasCalculationOperations, NftAsset } from '@core/network/api/nfts/types'
import { SpinningLoader, Text } from 'blockchain-info-components'
import CoinDisplay from 'components/Display/CoinDisplay'
import FiatDisplay from 'components/Display/FiatDisplay'
import { Flex } from 'components/Flex'
import { orderFromJSON } from 'data/components/nfts/utils'

import { RightAlign } from '../../components'
import FeesDropdown from '../../components/FeesDropdown'
import { Props as OwnProps } from '..'
import { getTotalFees } from '../NftOrderUtils'

const Fees: React.FC<Props> = (props) => {
  const { asset, nftActions, orderFlow } = props

  useEffect(() => {
    nftActions.fetchFees({
      operation: GasCalculationOperations.AcceptOffer,
      order: orderFromJSON(orderFlow.orderToMatch)
    })
  }, [])

  return (
    <>
      {orderFlow.fees.cata({
        Failure: () => null,
        Loading: () => <SpinningLoader width='14px' height='14px' borderWidth='3px' />,
        NotAsked: () => <SpinningLoader width='14px' height='14px' borderWidth='3px' />,
        Success: (val) => {
          return (
            <FeesDropdown totalFees={getTotalFees(asset, val)}>
              {asset.asset_contract?.opensea_seller_fee_basis_points > 0 ? (
                <Flex justifyContent='space-between' alignItems='center'>
                  <Text size='14px' weight={500}>
                    OpenSea Service Fee
                  </Text>
                  <Text size='14px' color='black' weight={600}>
                    {asset.asset_contract.opensea_seller_fee_basis_points / 100}%
                  </Text>
                </Flex>
              ) : null}
              {Number(asset.collection?.dev_seller_fee_basis_points) > 0 ? (
                <Flex justifyContent='space-between' alignItems='center'>
                  <Text size='14px' weight={500}>
                    Creator Royalty
                  </Text>
                  <Text size='14px' color='black' weight={600}>
                    {Number(asset.collection.dev_seller_fee_basis_points) / 100}%
                  </Text>
                </Flex>
              ) : null}
              <Flex justifyContent='space-between' alignItems='center'>
                <Text size='14px' weight={500}>
                  <FormattedMessage id='copy.network_fees' defaultMessage='Network Fees' />
                </Text>
                <RightAlign>
                  <CoinDisplay size='14px' color='black' weight={600} coin='ETH'>
                    {new BigNumber(val.totalFees).multipliedBy(val.gasPrice).toString()}
                  </CoinDisplay>
                  <FiatDisplay size='12px' color='grey600' weight={600} coin='ETH'>
                    {new BigNumber(val.totalFees).multipliedBy(val.gasPrice).toString()}
                  </FiatDisplay>
                </RightAlign>
              </Flex>
            </FeesDropdown>
          )
        }
      })}
    </>
  )
}

type Props = OwnProps & { asset: NftAsset }

export default Fees
