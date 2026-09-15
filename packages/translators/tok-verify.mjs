
import { getEncoding } from 'js-tiktoken'
const enc = getEncoding('o200k_base')
const count = (s) => enc.encode(s).length
const schema = '{"properties":{"city":{"type":"string"}},"required":["city"],"type":"object"}'
console.log('with function-type seg:', count(['system','You are terse.','user','Hello there, count me.','function','Get_Weather','Get current weather',schema].join('\n')))
