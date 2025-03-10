import React, { useMemo } from 'react'
import { useSortBy, useTable } from 'react-table'
import { colors } from '@blockchain-com/constellation'
import styled from 'styled-components'

import { HeaderText, HeaderToggle, StickyTableHeader, TableWrapper } from 'components/Table'
import { CollectionsQuery } from 'generated/graphql.types'

import { Props as OwnProps } from '../Home'
import { getFloorPriceColumn } from './floor_price'
import { getNameColumn } from './name.column'
import { getOwnersColumn } from './owners.column'
import { getTotalSupplyColumn } from './supply.column'
import { getVolumeColumn } from './volume.column'

export const getTableColumns = () => [
  getNameColumn(),
  getVolumeColumn(),
  getFloorPriceColumn(),
  getOwnersColumn(),
  getTotalSupplyColumn()
]

export const NftTableWrapper = styled(TableWrapper)`
  .table {
    .th {
      background: ${colors.grey000};
    }
  }
`

const TrendingCollectionsTable: React.FC<Props> = ({ collections }) => {
  const { getTableBodyProps, getTableProps, headerGroups, prepareRow, rows } = useTable(
    {
      columns: useMemo(() => getTableColumns(), []),
      data: useMemo(() => collections, [collections]),
      disableMultiSort: true,
      disableSortRemove: true,
      initialState: {
        sortBy: [{ desc: true, id: 'stats.one_day_volume' }]
      }
    },
    useSortBy
  )

  return (
    <NftTableWrapper>
      <div {...getTableProps({ style: { height: '360px', overflow: 'scroll' } })} className='table'>
        <StickyTableHeader>
          {headerGroups.map((headerGroup) => (
            // eslint-disable-next-line react/jsx-key
            <div {...headerGroup.getHeaderGroupProps({})} className='tr'>
              {headerGroup.headers.map((column) => (
                <div
                  key={column.key}
                  {...column.getHeaderProps(column.getSortByToggleProps())}
                  className='th'
                >
                  <HeaderText>
                    {column.render('Header')}
                    <div>
                      {column.isSorted ? (
                        column.isSortedDesc ? (
                          <HeaderToggle>▾</HeaderToggle>
                        ) : (
                          <HeaderToggle>▴</HeaderToggle>
                        )
                      ) : (
                        ''
                      )}
                    </div>
                  </HeaderText>
                </div>
              ))}
            </div>
          ))}
        </StickyTableHeader>
        <div {...getTableBodyProps()}>
          {rows.map((row) => {
            prepareRow(row)
            return (
              <div key={`row-${row.id}`} {...row.getRowProps()} className='tr'>
                {row.cells.map((cell) => (
                  <div key={`cell-${cell.row.id}`} {...cell.getCellProps()} className='td'>
                    {cell.render('Cell')}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </NftTableWrapper>
  )
}

type Props = OwnProps & {
  collections: CollectionsQuery['collections']
}

export default TrendingCollectionsTable
