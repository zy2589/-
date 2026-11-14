import sys


# Keep development launches from scattering __pycache__ folders in the project.
sys.dont_write_bytecode = True

from core.ui import ClipAssistant


if __name__ == "__main__":
    ClipAssistant().run()
