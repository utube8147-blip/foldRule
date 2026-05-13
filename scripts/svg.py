#!/usr/bin/env python3
"""
SVG Analyzer - Extract lines, stroke widths, and enclosed regions from SVG files
"""

import xml.etree.ElementTree as ET
import re
from collections import defaultdict, Counter
import math

class SVGAnalyzer:
    def __init__(self, svg_file):
        self.svg_file = svg_file
        self.ns = {
            'svg': 'http://www.w3.org/2000/svg',
            'default': 'http://www.w3.org/2000/svg'
        }
        self.elements = []
        self.stroke_stats = defaultdict(list)
        self.regions = []
        
    def parse(self):
        """Parse SVG file and extract elements"""
        tree = ET.parse(self.svg_file)
        root = tree.getroot()
        
        # Find all path elements
        for elem in root.findall('.//svg:path', self.ns):
            self.analyze_path(elem)
            
        # Find all line elements
        for elem in root.findall('.//svg:line', self.ns):
            self.analyze_line(elem)
            
        # Find all rect elements
        for elem in root.findall('.//svg:rect', self.ns):
            self.analyze_rect(elem)
            
        # Find all polygon/polyline elements
        for elem in root.findall('.//svg:polygon', self.ns):
            self.analyze_polygon(elem)
        for elem in root.findall('.//svg:polyline', self.ns):
            self.analyze_polygon(elem)
            
    def get_stroke_width(self, elem):
        """Extract stroke width from element"""
        stroke_width = elem.get('stroke-width')
        if stroke_width is None:
            # Check for stroke-width in style attribute
            style = elem.get('style', '')
            match = re.search(r'stroke-width:([0-9.]+)', style)
            if match:
                return float(match.group(1))
            return 0  # No stroke
        return float(stroke_width)
    
    def get_stroke_color(self, elem):
        """Extract stroke color from element"""
        stroke = elem.get('stroke')
        if stroke is None:
            style = elem.get('style', '')
            match = re.search(r'stroke:([^;]+)', style)
            if match:
                return match.group(1)
            return 'none'
        return stroke
    
    def get_fill_color(self, elem):
        """Extract fill color from element"""
        fill = elem.get('fill')
        if fill is None:
            style = elem.get('style', '')
            match = re.search(r'fill:([^;]+)', style)
            if match:
                return match.group(1)
            return 'none'
        return fill
    
    def parse_path_d(self, d_string):
        """Parse path 'd' attribute and return list of coordinates"""
        # Remove commas and normalize
        d_string = re.sub(r'[,]', ' ', d_string)
        # Split by commands (M, L, H, V, C, Q, A, Z)
        tokens = re.findall(r'([MLHVCSQTAZ])([^MLHVCSQTAZ]*)', d_string, re.IGNORECASE)
        
        points = []
        current_x, current_y = 0, 0
        
        for cmd, coords_str in tokens:
            coords = [float(x) for x in re.findall(r'-?\d+(?:\.\d+)?', coords_str)]
            
            if cmd.upper() == 'M':
                for i in range(0, len(coords), 2):
                    x, y = coords[i], coords[i+1]
                    points.append((x, y))
                    current_x, current_y = x, y
                    
            elif cmd.upper() == 'L':
                for i in range(0, len(coords), 2):
                    x, y = coords[i], coords[i+1]
                    points.append((x, y))
                    current_x, current_y = x, y
                    
            elif cmd.upper() == 'H':
                for x in coords:
                    points.append((x, current_y))
                    current_x = x
                    
            elif cmd.upper() == 'V':
                for y in coords:
                    points.append((current_x, y))
                    current_y = y
                    
            elif cmd.upper() == 'Z':
                if points and len(points) > 0:
                    # Close path back to first point
                    first_point = points[0]
                    points.append(first_point)
                    
        return points
    
    def analyze_path(self, elem):
        """Analyze a path element"""
        d = elem.get('d')
        if not d:
            return
            
        points = self.parse_path_d(d)
        if not points:
            return
            
        stroke_width = self.get_stroke_width(elem)
        stroke_color = self.get_stroke_color(elem)
        fill_color = self.get_fill_color(elem)
        
        # Calculate bounding box
        if points:
            xs = [p[0] for p in points]
            ys = [p[1] for p in points]
            bbox = (min(xs), min(ys), max(xs), max(ys))
        else:
            bbox = None
        
        # Calculate approximate length (sum of distances between points)
        length = 0
        for i in range(len(points) - 1):
            dx = points[i+1][0] - points[i][0]
            dy = points[i+1][1] - points[i][1]
            length += math.sqrt(dx*dx + dy*dy)
        
        element_info = {
            'type': 'path',
            'stroke_width': stroke_width,
            'stroke_color': stroke_color,
            'fill_color': fill_color,
            'points': points,
            'bbox': bbox,
            'length': length,
            'segment_count': len(points) - 1
        }
        
        self.elements.append(element_info)
        
        if stroke_width > 0:
            self.stroke_stats[stroke_width].append(element_info)
            
        # Check if this forms an enclosed region (fill is not none or path is closed)
        if fill_color != 'none' or (points and points[0] == points[-1]):
            self.regions.append(element_info)
    
    def analyze_line(self, elem):
        """Analyze a line element"""
        x1 = float(elem.get('x1', 0))
        y1 = float(elem.get('y1', 0))
        x2 = float(elem.get('x2', 0))
        y2 = float(elem.get('y2', 0))
        
        stroke_width = self.get_stroke_width(elem)
        stroke_color = self.get_stroke_color(elem)
        
        dx = x2 - x1
        dy = y2 - y1
        length = math.sqrt(dx*dx + dy*dy)
        
        element_info = {
            'type': 'line',
            'x1': x1, 'y1': y1,
            'x2': x2, 'y2': y2,
            'stroke_width': stroke_width,
            'stroke_color': stroke_color,
            'length': length,
            'bbox': (min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2))
        }
        
        self.elements.append(element_info)
        
        if stroke_width > 0:
            self.stroke_stats[stroke_width].append(element_info)
    
    def analyze_rect(self, elem):
        """Analyze a rectangle element"""
        x = float(elem.get('x', 0))
        y = float(elem.get('y', 0))
        width = float(elem.get('width', 0))
        height = float(elem.get('height', 0))
        
        stroke_width = self.get_stroke_width(elem)
        stroke_color = self.get_stroke_color(elem)
        fill_color = self.get_fill_color(elem)
        
        # Create points for the rectangle
        points = [
            (x, y),
            (x + width, y),
            (x + width, y + height),
            (x, y + height),
            (x, y)  # Close the rectangle
        ]
        
        element_info = {
            'type': 'rect',
            'x': x, 'y': y,
            'width': width, 'height': height,
            'stroke_width': stroke_width,
            'stroke_color': stroke_color,
            'fill_color': fill_color,
            'points': points,
            'area': width * height,
            'bbox': (x, y, x + width, y + height)
        }
        
        self.elements.append(element_info)
        
        if stroke_width > 0:
            self.stroke_stats[stroke_width].append(element_info)
            
        # Rectangles are always enclosed regions
        if fill_color != 'none':
            self.regions.append(element_info)
    
    def analyze_polygon(self, elem):
        """Analyze polygon/polyline elements"""
        points_str = elem.get('points', '')
        points = []
        
        # Parse points
        coords = re.findall(r'([-\d.]+)[,\s]+([-\d.]+)', points_str)
        for x, y in coords:
            points.append((float(x), float(y)))
            
        stroke_width = self.get_stroke_width(elem)
        stroke_color = self.get_stroke_color(elem)
        fill_color = self.get_fill_color(elem)
        
        # Calculate area using shoelace formula
        area = 0
        for i in range(len(points)):
            x1, y1 = points[i]
            x2, y2 = points[(i + 1) % len(points)]
            area += x1 * y2 - x2 * y1
        area = abs(area) / 2
        
        element_info = {
            'type': 'polygon',
            'stroke_width': stroke_width,
            'stroke_color': stroke_color,
            'fill_color': fill_color,
            'points': points,
            'area': area,
            'vertex_count': len(points)
        }
        
        self.elements.append(element_info)
        
        if stroke_width > 0:
            self.stroke_stats[stroke_width].append(element_info)
            
        if fill_color != 'none':
            self.regions.append(element_info)
    
    def find_intersections(self):
        """Find intersections between lines (simplified)"""
        intersections = []
        
        for i, elem1 in enumerate(self.elements):
            for elem2 in self.elements[i+1:]:
                # Simplified intersection detection for lines
                if elem1['type'] == 'line' and elem2['type'] == 'line':
                    inter = self.line_intersection(
                        (elem1['x1'], elem1['y1']), (elem1['x2'], elem1['y2']),
                        (elem2['x1'], elem2['y1']), (elem2['x2'], elem2['y2'])
                    )
                    if inter:
                        intersections.append(inter)
                        
        return intersections
    
    def line_intersection(self, p1, p2, p3, p4):
        """Calculate intersection point of two line segments"""
        x1, y1 = p1
        x2, y2 = p2
        x3, y3 = p3
        x4, y4 = p4
        
        denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
        if denom == 0:
            return None
            
        t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom
        u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom
        
        if 0 <= t <= 1 and 0 <= u <= 1:
            x = x1 + t * (x2 - x1)
            y = y1 + t * (y2 - y1)
            return (x, y)
        return None
    
    def generate_report(self):
        """Generate a comprehensive analysis report"""
        print("=" * 60)
        print(f"SVG ANALYSIS REPORT: {self.svg_file}")
        print("=" * 60)
        
        # Basic statistics
        print(f"\n📊 BASIC STATISTICS:")
        print(f"  Total elements: {len(self.elements)}")
        print(f"  Paths: {sum(1 for e in self.elements if e['type'] == 'path')}")
        print(f"  Lines: {sum(1 for e in self.elements if e['type'] == 'line')}")
        print(f"  Rectangles: {sum(1 for e in self.elements if e['type'] == 'rect')}")
        print(f"  Polygons: {sum(1 for e in self.elements if e['type'] == 'polygon')}")
        print(f"  Enclosed regions: {len(self.regions)}")
        
        # Stroke width statistics
        print(f"\n🎨 STROKE WIDTHS:")
        widths = sorted(self.stroke_stats.keys())
        for width in widths:
            count = len(self.stroke_stats[width])
            elements_with_width = self.stroke_stats[width]
            
            # Categorize thickness
            if width <= 0.5:
                category = "Very thin"
            elif width <= 1.0:
                category = "Thin"
            elif width <= 2.0:
                category = "Medium"
            elif width <= 3.0:
                category = "Thick"
            else:
                category = "Very thick"
                
            print(f"  {width:.2f} ({category}) : {count} element(s)")
            
            # Show some examples
            for elem in elements_with_width[:3]:
                if elem['type'] == 'line':
                    print(f"    - Line from ({elem['x1']:.0f},{elem['y1']:.0f}) to ({elem['x2']:.0f},{elem['y2']:.0f})")
                elif elem['type'] == 'rect':
                    print(f"    - Rectangle {elem['width']:.0f}x{elem['height']:.0f}")
                elif elem['type'] == 'path':
                    print(f"    - Path with {elem['segment_count']} segments, length {elem['length']:.1f}")
        
        # Enclosed regions
        if self.regions:
            print(f"\n📐 ENCLOSED REGIONS:")
            for i, region in enumerate(self.regions, 1):
                area = region.get('area', 0)
                if area == 0 and region.get('points'):
                    # Calculate approximate area for paths
                    points = region['points']
                    if points and points[0] == points[-1]:
                        area = 0
                        for j in range(len(points) - 1):
                            x1, y1 = points[j]
                            x2, y2 = points[j+1]
                            area += x1 * y2 - x2 * y1
                        area = abs(area) / 2
                
                if area > 0:
                    print(f"  Region {i}: Area ≈ {area:.1f} sq units")
                print(f"    Type: {region['type']}")
                print(f"    Fill: {region.get('fill_color', 'none')}")
                print(f"    Stroke: {region.get('stroke_color', 'none')} (width={region.get('stroke_width', 0):.2f})")
        
        # Color analysis
        colors = defaultdict(int)
        for elem in self.elements:
            color = elem.get('stroke_color', 'none')
            if color and color != 'none':
                colors[color] += 1
        
        if colors:
            print(f"\n🎨 COLOR USAGE:")
            for color, count in sorted(colors.items(), key=lambda x: x[1], reverse=True):
                print(f"  {color}: {count} element(s)")
        
        # Length analysis for lines
        lines = [e for e in self.elements if e['type'] == 'line']
        if lines:
            total_length = sum(e['length'] for e in lines)
            avg_length = total_length / len(lines)
            print(f"\n📏 LINE LENGTH ANALYSIS:")
            print(f"  Total line length: {total_length:.1f} units")
            print(f"  Average line length: {avg_length:.1f} units")
            print(f"  Longest line: {max(e['length'] for e in lines):.1f} units")
            print(f"  Shortest line: {min(e['length'] for e in lines):.1f} units")
        
        # Find intersections
        intersections = self.find_intersections()
        if intersections:
            print(f"\n🔗 INTERSECTIONS FOUND:")
            print(f"  Total intersection points: {len(intersections)}")
            # Show first 5 intersections
            for i, inter in enumerate(intersections[:5], 1):
                print(f"  {i}. ({inter[0]:.1f}, {inter[1]:.1f})")
            if len(intersections) > 5:
                print(f"  ... and {len(intersections) - 5} more")
        
        print("\n" + "=" * 60)
        
    def export_to_json(self, output_file):
        """Export analysis results to JSON"""
        import json
        
        # Prepare data for JSON export
        export_data = {
            'file': self.svg_file,
            'statistics': {
                'total_elements': len(self.elements),
                'element_types': {
                    'path': sum(1 for e in self.elements if e['type'] == 'path'),
                    'line': sum(1 for e in self.elements if e['type'] == 'line'),
                    'rect': sum(1 for e in self.elements if e['type'] == 'rect'),
                    'polygon': sum(1 for e in self.elements if e['type'] == 'polygon'),
                },
                'enclosed_regions': len(self.regions),
                'stroke_widths': {
                    str(width): len(self.stroke_stats[width])
                    for width in self.stroke_stats
                }
            },
            'elements': []
        }
        
        # Add elements (simplified for JSON)
        for elem in self.elements[:100]:  # Limit to first 100 for JSON size
            simplified = {
                'type': elem['type'],
                'stroke_width': elem.get('stroke_width', 0),
                'stroke_color': elem.get('stroke_color', 'none')
            }
            if elem['type'] == 'line':
                simplified['length'] = elem['length']
                simplified['bbox'] = elem['bbox']
            elif elem['type'] in ['rect', 'polygon']:
                simplified['area'] = elem.get('area', 0)
            export_data['elements'].append(simplified)
        
        with open(output_file, 'w') as f:
            json.dump(export_data, f, indent=2)
        
        print(f"\n✅ Exported analysis to {output_file}")
    
    def find_rooms(self):
        """Identify potential rooms from enclosed regions"""
        print(f"\n🏠 POTENTIAL ROOMS/SPACES:")
        rooms = []
        
        for region in self.regions:
            if region.get('fill_color') != 'none':
                area = region.get('area', 0)
                
                # Look for text labels nearby (simplified - would need text extraction)
                room_info = {
                    'type': region['type'],
                    'area': area,
                    'fill': region.get('fill_color'),
                    'bbox': region.get('bbox')
                }
                
                if area > 0:
                    # Categorize by size
                    if area < 5000:
                        category = "Small (closet, bathroom)"
                    elif area < 15000:
                        category = "Medium (office, meeting room)"
                    elif area < 30000:
                        category = "Large (open plan, boardroom)"
                    else:
                        category = "Very large (lobby, corridor)"
                        
                    rooms.append((room_info, category))
        
        for i, (room, category) in enumerate(rooms[:10], 1):
            print(f"  Room {i}: Area = {room['area']:.0f} sq units - {category}")
        
        if len(rooms) > 10:
            print(f"  ... and {len(rooms) - 10} more regions")
        
        return rooms

def main():
    import sys
    
    if len(sys.argv) < 2:
        print("Usage: python svg_analyzer.py <svg_file> [--json output.json]")
        sys.exit(1)
    
    svg_file = sys.argv[1]
    analyzer = SVGAnalyzer(svg_file)
    
    print(f"🔍 Analyzing {svg_file}...\n")
    analyzer.parse()
    analyzer.generate_report()
    
    # Find potential rooms
    analyzer.find_rooms()
    
    # Export to JSON if requested
    if '--json' in sys.argv:
        json_index = sys.argv.index('--json')
        if json_index + 1 < len(sys.argv):
            output_file = sys.argv[json_index + 1]
            analyzer.export_to_json(output_file)

if __name__ == "__main__":
    main()