import os
from tools import helpers
from . import shapes


def main():
    print(helpers.total(os.environ.get("ROWS", "")), shapes)
