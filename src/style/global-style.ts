import {addGlobalStyle, css} from '@pucelle/lupos.js'
import {theme} from './theme'


addGlobalStyle(() => {
	let {textColor, fontSize, lineHeight, backgroundColor} = theme

	return css`
	html{
		color: ${textColor};
		font-size: ${fontSize}px;
		line-height: ${lineHeight}px;
		background-color: ${backgroundColor};
	}

	::-webkit-scrollbar{
		height: 10px;
		width: 10px;
		background: ${backgroundColor.toIntermediate(0.04)};
	}

	::-webkit-scrollbar-thumb{
		background: ${backgroundColor.toIntermediate(0.12)};

		&:hover{
			background: ${backgroundColor.toIntermediate(0.16)};
		}

		&:active{
			background: ${backgroundColor.toIntermediate(0.2)};
		}
	}
`})