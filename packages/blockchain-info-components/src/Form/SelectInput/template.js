import React from 'react'
import PropTypes from 'prop-types'
import styled from 'styled-components'
import Select, { components } from 'react-select'
import { equals, flatten, filter, head, assoc, path } from 'ramda'

const StyledSelect = styled(Select)`
  font-weight: 400;
  font-family: 'Montserrat', sans-serif;
  font-size: ${props => (props.fontSize === 'small' ? '12px' : '14px')};

  .bc__menu {
    background-color: ${props => props.theme['white']};
  }

  .bc__menu-list {
    padding: 0;
  }

  .bc__group {
    padding-bottom: 0;
    > div:nth-child(2) {
      .bc__option {
        padding-top: 6px;
      }
    }
  }

  .bc__group-heading {
    font-weight: 400;
    margin-bottom: 0px;
    color: ${props => props.theme['gray-5']};
  }

  .bc__placeholder {
    color: ${props => props.theme['gray-2']};
  }

  .bc__control {
    box-shadow: none;
    color: ${props => props.theme['gray-5']};
    background-color: ${props => props.theme['white']};
    cursor: pointer;
    min-height: 40px;
    border-radius: 4px;
    border: 1px solid ${props => props.theme[props.borderColor]};
    &:hover {
      border: 1px solid ${props => props.theme[props.borderColor]};
    }
    &:active {
      border: 1px solid ${props => props.theme[props.borderColor]};
      box-shadow: none;
    }
    &:disabled {
      cursor: not-allowed;
      background-color: ${props => props.theme['gray-1']};
    }
    .bc__value-container {
      overflow: hidden;
    }

    input {
      border: none !important;
    }
  }

  .bc__indicator-separator {
    display: none;
  }

  .bc__option {
    cursor: pointer;
    color: ${props => props.theme['gray-5']};
    background-color: ${props => props.theme['white']};
    &.bc__option--is-focused {
      background-color: ${props => props.theme['white']};
      color: ${props => props.theme['brand-primary']};
    }
    &.bc__option--is-selected {
      color: ${props => props.theme['brand-primary']};
      background-color: ${props => props.theme['white']};
      &:hover {
        color: ${props => props.theme['brand-primary']};
      }
      * {
        color: ${props => props.theme['brand-primary']};
      }
    }
    &:hover {
      background-color: ${props => props.theme['white']};
      * {
        color: ${props => props.theme['brand-primary']};
      }
    }
    * {
      font-weight: 400;
      color: ${props => props.theme['gray-5']};
      transition: color 0.3s;
    }
  }

  .bc__single-value {
    color: ${props => props.theme['gray-5']};
  }
`

const Option = props => {
  const itemProps = assoc('text', props.label, props)
  return (
    <components.Option {...props}>
      {props.selectProps.templateItem
        ? props.selectProps.templateItem(itemProps)
        : props.children}
    </components.Option>
  )
}

const Control = props => {
  return props.selectProps.hideFocusedControl &&
    props.selectProps.menuIsOpen ? null : (
    <components.Control {...props} />
  )
}

const ValueContainer = ({ children, ...props }) => {
  const displayProps = assoc(
    'text',
    path(['selectProps', 'value', 'label'], props),
    assoc('value', path(['selectProps', 'value', 'value'], props), props)
  )
  return (
    <components.ValueContainer {...props}>
      {props.selectProps.templateDisplay
        ? props.selectProps.templateDisplay(displayProps, children)
        : children}
    </components.ValueContainer>
  )
}

const DropdownIndicator = props => {
  return props.selectProps.hideIndicator ? null : (
    <components.DropdownIndicator {...props} />
  )
}

const IndicatorSeparator = props => {
  return props.selectProps.hideIndicator ? null : (
    <components.IndicatorSeparator {...props} />
  )
}

const selectBorderColor = state => {
  switch (state) {
    case 'initial':
      return 'gray-2'
    case 'invalid':
      return 'error'
    case 'valid':
      return 'success'
    default:
      return 'gray-2'
  }
}

const SelectInput = props => {
  const {
    items,
    className,
    disabled,
    defaultItem,
    defaultDisplay,
    searchEnabled,
    templateItem,
    templateDisplay,
    hideFocusedControl,
    hideIndicator,
    handleChange,
    errorState,
    menuIsOpen,
    menuPlacement,
    openMenuOnFocus,
    onFocus,
    grouped,
    onBlur,
    onKeyDown,
    getRef,
    filterOption
  } = props
  const options = grouped
    ? items
    : items.map(item => ({ value: item.value, label: item.text }))
  const groupedOptions = grouped && flatten(options.map(o => o.options))
  const defaultValue = grouped
    ? head(filter(x => equals(x.value, defaultItem), groupedOptions))
    : head(filter(x => equals(x.value, defaultItem), options))
  const borderColor = selectBorderColor(errorState)

  return (
    <StyledSelect
      className={className}
      classNamePrefix='bc'
      options={options}
      borderColor={borderColor}
      templateItem={templateItem}
      templateDisplay={templateDisplay}
      components={{
        Option,
        ValueContainer,
        Control,
        DropdownIndicator,
        IndicatorSeparator
      }}
      hideFocusedControl={hideFocusedControl}
      hideIndicator={hideIndicator}
      placeholder={defaultDisplay}
      isSearchable={searchEnabled}
      onChange={handleChange}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      menuIsOpen={menuIsOpen}
      openMenuOnFocus={openMenuOnFocus}
      ref={getRef}
      menuPlacement={menuPlacement}
      isDisabled={disabled}
      value={defaultValue}
      filterOption={filterOption}
    />
  )
}

SelectInput.propTypes = {
  items: PropTypes.array.isRequired,
  selected: PropTypes.object,
  expanded: PropTypes.bool,
  searchEnabled: PropTypes.bool,
  menuIsOpen: PropTypes.bool,
  openMenuOnFocus: PropTypes.bool,
  disabled: PropTypes.bool,
  errorState: PropTypes.string,
  handleChange: PropTypes.func,
  handleClick: PropTypes.func,
  onFocus: PropTypes.func,
  onBlur: PropTypes.func,
  templateItem: PropTypes.func,
  getRef: PropTypes.func,
  fontSize: PropTypes.string,
  filterOption: PropTypes.func
}

export default SelectInput
