from django import template

from workbench.business_urls import public_url


register = template.Library()


@register.filter
def business_url(value):
    return public_url(value)


@register.simple_tag
def business_path(*parts):
    return public_url("".join(str(part) for part in parts))
