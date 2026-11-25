import { textField, slider, form as makeForm, tabs, codeBlock, divider } from '../../types/index.js'
import type { View, ViewTextFieldComponent, ViewFormComponent, ViewSliderComponent } from '../../types/index.js'

const name: ViewTextFieldComponent = { type: 'textField', label: 'Name', bind: 'data.form.name', required: true, maxLength: 80, pattern: 'slug' }
const range: ViewSliderComponent = { type: 'slider', label: 'Range', bind: 'data.form.range', range: true, min: 0, max: 100, step: 5 }
const form: ViewFormComponent = { type: 'form', v: 2, submit: 'save', children: [name, range] }
const view: View = { type: 'tabs', v: 2, items: [{ label: 'Edit', children: [form] }] }
// @ts-expect-error passwords are not part of the schema
const password: ViewTextFieldComponent = { type: 'textField', label: 'Password', obscureText: true }
// @ts-expect-error regex source is not a named pattern
const regex: ViewTextFieldComponent = { type: 'textField', label: 'Bad', pattern: '(a+)+$' }
void view; void password; void regex

const built: View = makeForm({ v: 2, submit: 'save', children: [
  textField({ label: 'Name', bind: 'data.name', maxLength: 80 }),
  slider({ label: 'Range', min: 0, max: 10, step: 1 }),
  codeBlock({ code: 'const n = 1', language: 'js' }),
  divider({}),
] })
const pages: View = tabs({ items: [{ label: 'Edit', children: [built] }] })
// @ts-expect-error a text field builder has no password argument
textField({ label: 'Password', obscureText: true })
void pages
