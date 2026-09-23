#!/usr/bin/env python3
"""Check a candidate Android Home screen in the connecting state: python3 homeHeaderLayoutCheck.py <adb-serial>."""

import re
import subprocess
import sys
import xml.etree.ElementTree as ET


def adb(serial, *args):
    return subprocess.check_output(['adb', '-s', serial, *args], text=True, timeout=40)


def rect(node):
    return tuple(map(int, re.findall(r'\d+', node.attrib['bounds'])))


def main(serial):
    size = re.findall(r'(\d+)x(\d+)', adb(serial, 'shell', 'wm', 'size'))[-1]
    density = int(re.findall(r'\d+', adb(serial, 'shell', 'wm', 'density'))[-1])
    scale = density / 160
    assert int(size[0]) / scale == 270, f'Expected a 270dp viewport, got {size[0]}px at {density}dpi'

    output = adb(serial, 'shell', '-tt', 'uiautomator', 'dump', '/dev/tty')
    xml = output[output.index('<hierarchy'):output.index('</hierarchy>') + len('</hierarchy>')]
    nodes = list(ET.fromstring(xml).iter('node'))

    def one(label, predicate):
        matches = [node for node in nodes if predicate(node)]
        assert len(matches) == 1, f'Expected one {label} on the connecting Home screen, got {len(matches)}'
        return rect(matches[0])

    actions = [one(label, lambda node: node.get('content-desc') == label)
               for label in ('Panes', 'Search', 'Settings')]
    top, bottom = actions[0][1], actions[0][3]
    status = one('connecting status', lambda node: node.get('text', '').lower().startswith('connect')
                 and top <= rect(node)[1] < bottom)
    title = one('Home title', lambda node: bool(node.get('text'))
                and top <= rect(node)[1] < status[1]
                and rect(node)[0] < actions[0][0])

    for action in actions:
        assert action[2] - action[0] >= 44 * scale, f'Action narrower than 44dp: {action}'
        assert action[3] - action[1] >= 44 * scale, f'Action shorter than 44dp: {action}'
    for left, right in zip(actions, actions[1:]):
        assert left[2] <= right[0], f'Adjacent action hit rects intersect: {left}, {right}'
    assert max(title[2], status[2]) <= actions[0][0], (
        f'Title/status overlaps actions: {title}, {status}, {actions[0]}'
    )
    print('270dp connecting Home: measured header rects do not overlap; actions have exclusive 44dp targets')


if __name__ == '__main__':
    assert len(sys.argv) == 2, 'Pass the serial of a device showing the candidate Home in the connecting state'
    main(sys.argv[1])
