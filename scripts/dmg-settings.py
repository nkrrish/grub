# dmgbuild settings for Grub's installer window. Used by scripts/make-dmg.sh.
# The background is drawn by build/dmg/background.html (render with: npx electron scripts/dmg-background.js);
# its arrow and mound line up with the icon positions below, so change them together.
import os.path

app = defines.get("app", "out/Grub-darwin-universal/Grub.app")  # noqa: F821 (defines is injected by dmgbuild)
appname = os.path.basename(app)

format = "UDZO"
filesystem = "HFS+"
files = [app]
symlinks = {"Applications": "/Applications"}
icon = "build/icon.icns"

background = "build/dmg/background.tiff"
window_rect = ((200, 140), (660, 420))
default_view = "icon-view"
show_toolbar = False
show_status_bar = False
show_tab_view = False
show_pathbar = False
show_sidebar = False
show_icon_preview = False

icon_size = 112
text_size = 13
arrange_by = None
icon_locations = {
    appname: (170, 210),
    "Applications": (490, 210),
}
